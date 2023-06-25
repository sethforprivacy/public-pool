import * as bitcoinjs from 'bitcoinjs-lib';
import * as crypto from 'crypto';
import { MerkleTree } from 'merkletreejs';

import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { eResponseMethod } from './enums/eResponseMethod';

interface AddressObject {
    address: string;
    percent: number;
}
export class MiningJob {

    private merkle_branch: string[]; // List of hashes, will be used for calculation of merkle root. This is not a list of all transactions, it only contains prepared hashes of steps of merkle tree algorithm.

    public jobId: string; // ID of the job. Use this ID while submitting share generated from this job.
    public response: string;
    public block: bitcoinjs.Block = new bitcoinjs.Block();
    public networkDifficulty: number;

    constructor(id: string, payoutInformation: AddressObject[], public blockTemplate: IBlockTemplate, public clean_jobs: boolean) {

        this.jobId = id;
        //this.target = blockTemplate.target;
        this.block.prevHash = this.convertToLittleEndian(blockTemplate.previousblockhash);

        this.block.version = blockTemplate.version;
        this.block.bits = parseInt(blockTemplate.bits, 16);
        this.networkDifficulty = this.calculateNetworkDifficulty(this.block.bits);
        this.block.timestamp = Math.floor(new Date().getTime() / 1000);

        this.block.transactions = blockTemplate.transactions.map(t => bitcoinjs.Transaction.fromHex(t.data));

        const coinbaseTransaction = this.createCoinbaseTransaction(payoutInformation, this.blockTemplate.height, this.blockTemplate.coinbasevalue);
        this.block.transactions.unshift(coinbaseTransaction);

        this.block.witnessCommit = bitcoinjs.Block.calculateMerkleRoot(this.block.transactions, true);

        this.block.merkleRoot = bitcoinjs.Block.calculateMerkleRoot(this.block.transactions, false);

        //The commitment is recorded in a scriptPubKey of the coinbase transaction. It must be at least 38 bytes, with the first 6-byte of 0x6a24aa21a9ed, that is:
        //     1-byte - OP_RETURN (0x6a)
        //     1-byte - Push the following 36 bytes (0x24)
        //     4-byte - Commitment header (0xaa21a9ed)
        const segwitMagicBits = Buffer.from('aa21a9ed', 'hex');
        //    32-byte - Commitment hash: Double-SHA256(witness root hash|witness reserved value)
        const commitmentHash = this.sha256(this.sha256(this.block.witnessCommit));
        //    39th byte onwards: Optional data with no consensus meaning
        coinbaseTransaction.outs[0].script = bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.concat([segwitMagicBits, commitmentHash])]);

        // get the non-witness coinbase tx
        //@ts-ignore
        const serializedCoinbaseTx = coinbaseTransaction.__toBuffer().toString('hex');

        const blockHeightScript = `03${this.blockTemplate.height.toString(16).padStart(8, '0')}` + '00000000' + '00000000';
        const partOneIndex = serializedCoinbaseTx.indexOf(blockHeightScript) + blockHeightScript.length;

        const coinbasePart1 = serializedCoinbaseTx.slice(0, partOneIndex);
        const coinbasePart2 = serializedCoinbaseTx.slice(partOneIndex);
        const coinb1 = coinbasePart1.slice(0, coinbasePart1.length - 16);
        const coinb2 = coinbasePart2;


        // Calculate merkle branch
        const transactionBuffers = this.block.transactions.map(tx => tx.getHash(false));

        const tree = new MerkleTree(transactionBuffers, this.sha256, { isBitcoinTree: true });
        this.merkle_branch = tree.getProof(coinbaseTransaction.getHash(false)).map(p => p.data.toString('hex'));

        this.block.transactions[0] = coinbaseTransaction;

        this.constructResponse(coinb1, coinb2);

    }

    public tryBlock(versionMaskString: number, nonce: number, extraNonce: string, extraNonce2: string): bitcoinjs.Block {

        const testBlock = bitcoinjs.Block.fromBuffer(this.block.toBuffer());

        testBlock.nonce = nonce;

        // recompute version mask
        const versionMask = versionMaskString;
        if (versionMask !== undefined && versionMask != 0) {
            testBlock.version = (testBlock.version ^ versionMask);
        }

        // set the nonces
        const blockHeightScript = `03${this.blockTemplate.height.toString(16).padStart(8, '0')}${extraNonce}${extraNonce2}`;
        const inputScript = bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.from(blockHeightScript, 'hex')]);
        testBlock.transactions[0].ins[0].script = inputScript;

        //@ts-ignore
        // const test = testBlock.transactions[0].__toBuffer();
        // console.log(test.toString('hex'))

        const newRoot = this.calculateMerkleRootHash(testBlock.transactions[0].__toBuffer(), this.merkle_branch);
        //recompute the root
        testBlock.merkleRoot = newRoot;

        return testBlock;
    }

    private calculateMerkleRootHash(coinbaseTx: string, merkleBranches: string[]): Buffer {

        let coinbaseTxBuf = Buffer.from(coinbaseTx, 'hex');

        const bothMerkles = Buffer.alloc(64);
        let test = this.sha256(coinbaseTxBuf)
        let newRoot = this.sha256(test);
        bothMerkles.set(newRoot);

        for (let i = 0; i < merkleBranches.length; i++) {
            bothMerkles.set(Buffer.from(merkleBranches[i], 'hex'), 32);
            newRoot = this.sha256(this.sha256(bothMerkles));
            bothMerkles.set(newRoot);
        }

        return bothMerkles.subarray(0, 32)
    }


    private createCoinbaseTransaction(addresses: AddressObject[], blockHeight: number, reward: number): bitcoinjs.Transaction {
        // Part 1
        const coinbaseTransaction = new bitcoinjs.Transaction();

        // Set the version of the transaction
        coinbaseTransaction.version = 2;

        const blockHeightScript = `03${blockHeight.toString(16).padStart(8, '0')}` + '00000000' + '00000000';

        const inputScript = bitcoinjs.script.compile([bitcoinjs.opcodes.OP_RETURN, Buffer.from(blockHeightScript, 'hex')])

        // Add the coinbase input (input with no previous output)
        coinbaseTransaction.addInput(Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'), 0xffffffff, 0xffffffff, inputScript);

        // Add an output
        let rewardBalance = reward;

        addresses.forEach(recipientAddress => {
            const scriptPubKey = bitcoinjs.payments.p2wpkh({ address: recipientAddress.address, network: bitcoinjs.networks.testnet });
            const amount = Math.floor((recipientAddress.percent / 100) * reward);
            rewardBalance -= amount;
            coinbaseTransaction.addOutput(scriptPubKey.output, amount);
        })

        //Add any remaining sats from the Math.floor 
        coinbaseTransaction.outs[0].value += rewardBalance;

        const segwitWitnessReservedValue = Buffer.alloc(32, 0);

        //and the coinbase's input's witness must consist of a single 32-byte array for the witness reserved value
        coinbaseTransaction.ins[0].witness = [segwitWitnessReservedValue];

        return coinbaseTransaction;
    }

    private sha256(data) {
        return crypto.createHash('sha256').update(data).digest()
    }


    private constructResponse(coinb1: string, coinb2: string) {

        const job = {
            id: null,
            method: eResponseMethod.MINING_NOTIFY,
            params: [
                this.jobId,
                this.swapEndianWords(this.block.prevHash).toString('hex'),
                coinb1,
                coinb2,
                this.merkle_branch,
                this.block.version.toString(16),
                this.block.bits.toString(16),
                this.block.timestamp.toString(16),
                this.clean_jobs
            ]
        };

        this.response = JSON.stringify(job);
    }


    private convertToLittleEndian(hash: string): Buffer {
        const bytes = Buffer.from(hash, 'hex');
        Array.prototype.reverse.call(bytes);
        return bytes;
    }

    private swapEndianWords(buffer: Buffer): Buffer {
        const swappedBuffer = Buffer.alloc(buffer.length);

        for (let i = 0; i < buffer.length; i += 4) {
            swappedBuffer[i] = buffer[i + 3];
            swappedBuffer[i + 1] = buffer[i + 2];
            swappedBuffer[i + 2] = buffer[i + 1];
            swappedBuffer[i + 3] = buffer[i];
        }

        return swappedBuffer;
    }


    private calculateNetworkDifficulty(nBits: number) {
        const mantissa: number = nBits & 0x007fffff;       // Extract the mantissa from nBits
        const exponent: number = (nBits >> 24) & 0xff;       // Extract the exponent from nBits

        const target: number = mantissa * Math.pow(256, (exponent - 3));   // Calculate the target value

        const difficulty: number = (Math.pow(2, 208) * 65535) / target;    // Calculate the difficulty

        return difficulty;
    }

}