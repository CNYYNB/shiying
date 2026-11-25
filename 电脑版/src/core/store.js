'use strict'
/** 设置与下载记录（JSON 文件，移植自 History.kt / Kv）。写入先写临时文件再改名，防止断电写坏。 */
const fs = require('fs')
const path = require('path')

function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return def } }
function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1))
  fs.renameSync(tmp, file)
}

class Settings {
  constructor(file, defaults) { this.file = file; this.v = { ...defaults, ...readJson(file, {}) } }
  get(k) { return this.v[k] }
  set(k, val) { this.v[k] = val; writeJson(this.file, this.v) }
  all() { return { ...this.v } }
}

/**
 * 下载记录，新的在前，最多 200 条。条目：
 * { key, id, title, author, isImages, time, status: running|done|failed|cancelled, message, files[], cover, platform, link, thumb }
 */
class History {
  constructor(file, { onDrop } = {}) { this.file = file; this.list = readJson(file, []); this.onDrop = onDrop || (() => {}) }
  save() { writeJson(this.file, this.list) }
  all() { return this.list.map(e => ({ ...e, files: [...(e.files || [])] })) }
  get(key) { return this.list.find(e => e.key === key) || null }
  put(e) {
    this.list = this.list.filter(x => x.key !== e.key)
    this.list.unshift(e)
    while (this.list.length > 200) this.onDrop(this.list.pop())
    this.save()
  }
  update(key, f) { const e = this.get(key); if (e) { f(e); this.save() } return e }
  remove(key) { const e = this.get(key); this.list = this.list.filter(x => x.key !== key); this.save(); if (e) this.onDrop(e) }
  clear() { for (const e of this.list) this.onDrop(e); this.list = []; this.save() }
  /** 上次没正常结束的“下载中”记录 → 失败 */
  fixStale(activeKeys = new Set()) {
    let ch = false
    for (const e of this.list) if (e.status === 'running' && !activeKeys.has(e.key)) { e.status = 'failed'; e.message = '下载被中断'; ch = true }
    if (ch) this.save()
  }
}

module.exports = { Settings, History, readJson, writeJson }
