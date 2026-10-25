/**
 * Extract files out of app.asar, with the archive read once.
 *
 *   node tools/asar-read.mjs <path> [path2 ...]
 *
 * The archive is 369 MB, so reading it per file is the wrong shape. This
 * reads it once, then prints each requested file with a header.
 *
 * An entry's offset is relative to the start of the file DATA region, which
 * begins after the header and its 4-byte alignment padding — not at byte 0 of
 * the archive. Getting that wrong lands in a different package's data.
 */

import { readFileSync } from 'node:fs'

const asarPath = process.env.ASAR_PATH ?? 'D:\\application\\dshdesktop\\DSH Desktop\\resources\\app.asar'
const targets = process.argv.slice(2)

if (targets.length === 0) {
  console.log('usage: node tools/asar-read.mjs <path> [path2 ...]')
  process.exit(1)
}

const buffer = readFileSync(asarPath)
let start = 8
while (start < 64 && buffer[start] !== 0x7b) start += 1
const headerLength = buffer.readUInt32LE(4)
const header = JSON.parse(buffer.subarray(start, start + headerLength).toString('utf8'))
const dataStart = 8 + Math.ceil(headerLength / 4) * 4

for (const target of targets) {
  let node = header
  for (const segment of target.split('/')) {
    node = node?.files?.[segment]
    if (node === undefined) break
  }
  if (node === undefined || node.files !== undefined) {
    console.log(`\n===== ${target}: NOT FOUND =====`)
    continue
  }
  const offset = Number(node.offset)
  const size = Number(node.size)
  console.log(`\n===== ${target} (${size} bytes) =====`)
  process.stdout.write(buffer.subarray(dataStart + offset, dataStart + offset + size))
  console.log('')
}
