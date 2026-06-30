/**
 * Gerador de ZIP mínimo em Node puro (sem dependências). Usado para empacotar a
 * pasta da extensão para download. Comprime com deflate quando vale a pena.
 */

const { deflateRawSync } = require('zlib');

const crcTable = (() => {
    const t = new Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// arquivos: [{ name: string, data: Buffer }]
function criarZip(arquivos) {
    const locais = [];
    const central = [];
    let offset = 0;

    for (const f of arquivos) {
        const nameBuf = Buffer.from(f.name, 'utf8');
        const data = f.data;
        const comp = deflateRawSync(data);
        const usarDeflate = comp.length < data.length;
        const corpo = usarDeflate ? comp : data;
        const metodo = usarDeflate ? 8 : 0;
        const crc = crc32(data);

        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);
        lh.writeUInt16LE(20, 4);
        lh.writeUInt16LE(0, 6);
        lh.writeUInt16LE(metodo, 8);
        lh.writeUInt16LE(0, 10);
        lh.writeUInt16LE(0x21, 12); // data fictícia
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(corpo.length, 18);
        lh.writeUInt32LE(data.length, 22);
        lh.writeUInt16LE(nameBuf.length, 26);
        lh.writeUInt16LE(0, 28);
        locais.push(lh, nameBuf, corpo);

        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0);
        ch.writeUInt16LE(20, 4);
        ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0, 8);
        ch.writeUInt16LE(metodo, 10);
        ch.writeUInt16LE(0, 12);
        ch.writeUInt16LE(0x21, 14);
        ch.writeUInt32LE(crc, 16);
        ch.writeUInt32LE(corpo.length, 20);
        ch.writeUInt32LE(data.length, 24);
        ch.writeUInt16LE(nameBuf.length, 28);
        ch.writeUInt16LE(0, 30);
        ch.writeUInt16LE(0, 32);
        ch.writeUInt16LE(0, 34);
        ch.writeUInt16LE(0, 36);
        ch.writeUInt32LE(0, 38);
        ch.writeUInt32LE(offset, 42);
        central.push(ch, nameBuf);

        offset += lh.length + nameBuf.length + corpo.length;
    }

    const localBuf = Buffer.concat(locais);
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(arquivos.length, 8);
    eocd.writeUInt16LE(arquivos.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(localBuf.length, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([localBuf, centralBuf, eocd]);
}

module.exports = { criarZip };
