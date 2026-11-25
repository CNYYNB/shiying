// 查看 Windows exe 的图标和版本信息（构建后自检用）：node tools/peinfo.js dist/win-unpacked/拾影.exe
const ResEdit = require('resedit'); const fs = require('fs')
for (const f of process.argv.slice(2)) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(f), { ignoreCert: true })
  const res = ResEdit.NtExecutableResource.from(exe)
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0]
  console.log(f, 'machine=0x' + exe.newHeader.fileHeader.machine.toString(16), 'iconGroups=', groups.map(g => g.icons.map(i => i.width || 256).join('/')).join(' | '))
  if (vi) console.log('  version', vi.getStringValues({ lang: vi.getAllLanguagesForStringValues()[0].lang, codepage: vi.getAllLanguagesForStringValues()[0].codepage }))
}
