'use strict'
/**
 * electron-builder 配置：electron-builder.yml，加上构建时可选的内置更新清单地址。
 * SHIYING_UPDATE_MANIFESTS="https://a/pc-version.json,https://b/pc-version.json" → 写进打包后 package.json 的 shiyingUpdate.manifests
 * （覆盖 package.json 里的默认列表，按顺序尝试）。没设置时就用 package.json 里的列表。
 */
function builderConfig(env = process.env) {
  const list = String(env.SHIYING_UPDATE_MANIFESTS || '').split(/[,\s]+/).filter(Boolean)
  if (!list.length) return 'electron-builder.yml'
  for (const u of list) if (!/^https:\/\//.test(u)) throw new Error('SHIYING_UPDATE_MANIFESTS 里的地址必须是 https：' + u)
  console.log('内置更新清单地址（构建时指定）：\n  ' + list.join('\n  '))
  return { extends: 'electron-builder.yml', extraMetadata: { shiyingUpdate: { manifests: list } } }
}
module.exports = { builderConfig }
