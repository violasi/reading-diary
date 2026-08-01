/** 解 .rdpkg（本质是 zip）→ 校验 manifest → 存进 IndexedDB */
import JSZip from 'jszip'
import type { PackManifest } from '../types'
import { savePack, type StoredPack } from './db'

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
}

const mimeOf = (path: string) => MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? ''

export class PackError extends Error {}

function validate(m: unknown): PackManifest {
  const man = m as PackManifest
  if (!man || man.format !== 'reading-diary-pack')
    throw new PackError('这不是「阅读打卡日记」的任务包')
  if (!man.date) throw new PackError('任务包里没有日期')
  if (!Array.isArray(man.pieces) || man.pieces.length === 0)
    throw new PackError('任务包里没有任何篇目')
  for (const p of man.pieces) {
    if (!p.id || !p.title) throw new PackError('有篇目缺少 id 或标题')
    if (!Array.isArray(p.pages) || p.pages.length === 0)
      throw new PackError(`《${p.title}》里没有页面`)
  }
  return man
}

export async function importPack(file: Blob): Promise<PackManifest> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(file)
  } catch {
    throw new PackError('这个文件打不开，可能不是任务包或者传输时损坏了')
  }

  const manifestEntry = zip.file('manifest.json')
  if (!manifestEntry) throw new PackError('任务包里找不到 manifest.json')

  let manifest: PackManifest
  try {
    manifest = validate(JSON.parse(await manifestEntry.async('text')))
  } catch (e) {
    if (e instanceof PackError) throw e
    throw new PackError('manifest.json 读不出来')
  }

  // 只取 manifest 真正引用到的文件，避免把无用内容也存进去
  const wanted = new Set<string>()
  for (const p of manifest.pieces) {
    if (p.cover) wanted.add(p.cover)
    if (p.listen?.audio) wanted.add(p.listen.audio)
    for (const pg of p.pages) {
      wanted.add(pg.image)
      if (pg.audio) wanted.add(pg.audio)
    }
  }

  const files: Record<string, Blob> = {}
  const missing: string[] = []
  for (const path of wanted) {
    const entry = zip.file(path)
    if (!entry) {
      missing.push(path)
      continue
    }
    const raw = await entry.async('blob')
    const type = mimeOf(path)
    files[path] = type ? new Blob([raw], { type }) : raw
  }
  if (missing.length)
    throw new PackError(`任务包缺了 ${missing.length} 个文件，第一个是 ${missing[0]}`)

  const pack: StoredPack = { manifest, files }
  await savePack(pack)
  return manifest
}

/**
 * 为一个包里的全部文件建 object URL。
 * 阅读页进入时一次性建好，翻页就不会有白屏等待；离开时必须 revoke。
 */
export function makeUrls(files: Record<string, Blob>) {
  const urls: Record<string, string> = {}
  for (const [path, blob] of Object.entries(files)) urls[path] = URL.createObjectURL(blob)
  return {
    urls,
    revoke: () => Object.values(urls).forEach(URL.revokeObjectURL),
  }
}
