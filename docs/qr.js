// A QR encoder, byte mode, error correction level M, versions 1 to 10.
//
// Written out rather than pulled from a CDN: this draws on a karyakar's phone
// at the moment twenty-five people are waiting to check in, and a third party
// script that fails to load then is a worse problem than the code below.
//
// Exposes qrMatrix(text) -> array of rows of booleans, true meaning dark.

(function (global) {
  'use strict';

  // Total codewords, EC codewords per block, and the block layout, for level M.
  const VERSIONS = [
    null,
    { total: 26, ec: 10, groups: [[1, 16]] },
    { total: 44, ec: 16, groups: [[1, 28]] },
    { total: 70, ec: 26, groups: [[1, 44]] },
    { total: 100, ec: 18, groups: [[2, 32]] },
    { total: 134, ec: 24, groups: [[2, 43]] },
    { total: 172, ec: 16, groups: [[4, 27]] },
    { total: 196, ec: 18, groups: [[4, 31]] },
    { total: 242, ec: 22, groups: [[2, 38], [2, 39]] },
    { total: 292, ec: 22, groups: [[3, 36], [2, 37]] },
    { total: 346, ec: 26, groups: [[4, 43], [1, 44]] },
  ];

  const ALIGNMENT = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  /* ---------- GF(256) ---------- */

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function buildTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  // The divisor polynomial, highest power first, with the leading 1 left off.
  // Built by repeatedly multiplying by (x - alpha^i).
  function generatorPoly(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = mul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = mul(root, 2);
    }
    return result;
  }

  function errorCorrection(data, ecLength) {
    const generator = generatorPoly(ecLength);
    const remainder = new Array(ecLength).fill(0);
    for (const byte of data) {
      const factor = byte ^ remainder[0];
      remainder.shift();
      remainder.push(0);
      if (factor !== 0) {
        for (let i = 0; i < ecLength; i++) {
          remainder[i] ^= mul(generator[i], factor);
        }
      }
    }
    return remainder;
  }

  /* ---------- data ---------- */

  function encodeData(bytes, version) {
    const info = VERSIONS[version];
    const dataCodewords = info.groups.reduce((sum, [count, size]) => sum + count * size, 0);
    const countBits = version < 10 ? 8 : 16;

    const bits = [];
    const push = (value, length) => {
      for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };

    push(0b0100, 4); // byte mode
    push(bytes.length, countBits);
    for (const byte of bytes) push(byte, 8);

    const capacity = dataCodewords * 8;
    for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }
    const PAD = [0xec, 0x11];
    let padIndex = 0;
    while (codewords.length < dataCodewords) codewords.push(PAD[padIndex++ % 2]);

    // Split into blocks, compute EC for each, then interleave both.
    const blocks = [];
    let offset = 0;
    for (const [count, size] of info.groups) {
      for (let i = 0; i < count; i++) {
        const block = codewords.slice(offset, offset + size);
        offset += size;
        blocks.push({ data: block, ec: errorCorrection(block, info.ec) });
      }
    }

    const result = [];
    const longest = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < longest; i++) {
      for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
    }
    for (let i = 0; i < info.ec; i++) {
      for (const block of blocks) result.push(block.ec[i]);
    }
    return result;
  }

  function pickVersion(byteLength) {
    for (let version = 1; version <= 10; version++) {
      const info = VERSIONS[version];
      const dataCodewords = info.groups.reduce((sum, [count, size]) => sum + count * size, 0);
      const countBits = version < 10 ? 8 : 16;
      if (byteLength * 8 + 4 + countBits <= dataCodewords * 8) return version;
    }
    throw new Error('Too much data for this encoder');
  }

  /* ---------- matrix ---------- */

  function blankMatrix(size) {
    return Array.from({ length: size }, () => new Array(size).fill(null));
  }

  function placeFinder(matrix, row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || x < 0 || y >= matrix.length || x >= matrix.length) continue;
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[y][x] = edge || core;
      }
    }
  }

  function reserveFormat(matrix, size) {
    for (let i = 0; i < 9; i++) {
      if (matrix[8][i] === null) matrix[8][i] = false;
      if (matrix[i][8] === null) matrix[i][8] = false;
    }
    for (let i = 0; i < 8; i++) {
      if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = false;
      if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = false;
    }
  }

  function buildFunctionPatterns(version) {
    const size = version * 4 + 17;
    const matrix = blankMatrix(size);

    placeFinder(matrix, 0, 0);
    placeFinder(matrix, 0, size - 7);
    placeFinder(matrix, size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
      const dark = i % 2 === 0;
      matrix[6][i] = dark;
      matrix[i][6] = dark;
    }

    for (const row of ALIGNMENT[version]) {
      for (const col of ALIGNMENT[version]) {
        // Not over the finder patterns.
        if ((row === 6 && col === 6) ||
            (row === 6 && col === size - 7) ||
            (row === size - 7 && col === 6)) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            matrix[row + r][col + c] =
              Math.max(Math.abs(r), Math.abs(c)) !== 1;
          }
        }
      }
    }

    matrix[size - 8][8] = true; // the dark module
    reserveFormat(matrix, size);

    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >> i) & 1) === 1;
        const row = Math.floor(i / 3);
        const col = size - 11 + (i % 3);
        matrix[row][col] = bit;
        matrix[col][row] = bit;
      }
    }
    return matrix;
  }

  function versionBits(version) {
    let remainder = version;
    for (let i = 0; i < 12; i++) {
      remainder = (remainder << 1) ^ ((remainder >> 11) * 0x1f25);
    }
    return ((version << 12) | remainder) >>> 0;
  }

  function formatBits(mask) {
    const ecBits = 0b00; // level M
    const data = (ecBits << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) {
      remainder = (remainder << 1) ^ ((remainder >> 9) * 0x537);
    }
    return (((data << 10) | remainder) ^ 0x5412) >>> 0;
  }

  // Both copies of the format information. matrix is indexed [row][column],
  // and getting that the wrong way round transposes the whole block: the two
  // copies then disagree and a scanner rejects the code.
  function placeFormat(matrix, mask) {
    const size = matrix.length;
    const bits = formatBits(mask);
    const bit = (i) => ((bits >> i) & 1) === 1;

    // Copy one: down the left of the top-right finder, then left along row 8.
    for (let i = 0; i <= 5; i++) matrix[i][8] = bit(i);
    matrix[7][8] = bit(6);
    matrix[8][8] = bit(7);
    matrix[8][7] = bit(8);
    for (let i = 9; i < 15; i++) matrix[8][14 - i] = bit(i);

    // Copy two: right along row 8, then down column 8 at the bottom.
    for (let i = 0; i < 8; i++) matrix[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) matrix[size - 15 + i][8] = bit(i);

    matrix[size - 8][8] = true; // always dark
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function placeData(matrix, codewords) {
    const size = matrix.length;
    const bits = [];
    for (const byte of codewords) {
      for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
    }

    let index = 0;
    let upward = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5; // the vertical timing column is skipped
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (const col of [right, right - 1]) {
          if (matrix[row][col] !== null) continue;
          matrix[row][col] = index < bits.length ? bits[index] === 1 : false;
          index++;
        }
      }
      upward = !upward;
    }
  }

  function penalty(matrix) {
    const size = matrix.length;
    let score = 0;

    const runScore = (run) => (run >= 5 ? 3 + (run - 5) : 0);
    for (let i = 0; i < size; i++) {
      for (const horizontal of [true, false]) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          const previous = horizontal ? matrix[i][j - 1] : matrix[j - 1][i];
          const current = horizontal ? matrix[i][j] : matrix[j][i];
          if (current === previous) run++;
          else {
            score += runScore(run);
            run = 1;
          }
        }
        score += runScore(run);
      }
    }

    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const value = matrix[r][c];
        if (value === matrix[r][c + 1] && value === matrix[r + 1][c] && value === matrix[r + 1][c + 1]) {
          score += 3;
        }
      }
    }

    const PATTERN = [true, false, true, true, true, false, true, false, false, false, false];
    const REVERSED = [...PATTERN].reverse();
    const matches = (line, start, pattern) =>
      pattern.every((bit, i) => line[start + i] === bit);
    for (let i = 0; i < size; i++) {
      const row = matrix[i];
      const column = matrix.map((line) => line[i]);
      for (let j = 0; j + 11 <= size; j++) {
        if (matches(row, j, PATTERN) || matches(row, j, REVERSED)) score += 40;
        if (matches(column, j, PATTERN) || matches(column, j, REVERSED)) score += 40;
      }
    }

    let dark = 0;
    for (const row of matrix) for (const cell of row) if (cell) dark++;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  function qrMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const version = pickVersion(bytes.length);
    const codewords = encodeData(bytes, version);

    const reserved = buildFunctionPatterns(version);
    const isFunction = reserved.map((row) => row.map((cell) => cell !== null));

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const matrix = reserved.map((row) => [...row]);
      placeData(matrix, codewords);
      for (let r = 0; r < matrix.length; r++) {
        for (let c = 0; c < matrix.length; c++) {
          if (!isFunction[r][c] && MASKS[mask](r, c)) matrix[r][c] = !matrix[r][c];
        }
      }
      placeFormat(matrix, mask);
      const score = penalty(matrix);
      if (!best || score < best.score) best = { score, matrix };
    }
    return best.matrix;
  }

  global.qrMatrix = qrMatrix;
})(typeof globalThis !== 'undefined' ? globalThis : this);
