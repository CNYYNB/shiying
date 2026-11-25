#!/bin/bash
# Deploy publish/site to Cloudflare Pages project myplayer-louis.
# Proxy injects the CF API token on api.cloudflare.com and clobbers the asset JWT,
# so asset calls go direct (--noproxy) with the JWT; token calls go via proxy.
set -e
A=${CF_ACCOUNT_ID:?set CF_ACCOUNT_ID}; P=${CF_PAGES_PROJECT:-shiying-louis}; SITE=${SITE:-/tmp/sy-site}; W=$(mktemp -d)
pip -q install blake3 >/dev/null 2>&1 || true
JWT=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$A/pages/projects/$P/upload-token" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['jwt'])")
python3 - "$SITE" "$W" <<'PY'
import blake3,base64,os,json,sys
site,w=sys.argv[1],sys.argv[2]; man={}; out=[]
ct={'json':'application/json','apk':'application/vnd.android.package-archive'}
for f in os.listdir(site):
    if f.startswith('_'): continue
    b=open(os.path.join(site,f),'rb').read(); ext=f.rsplit('.',1)[-1]
    h=blake3.blake3((base64.b64encode(b).decode()+ext).encode()).hexdigest()[:32]
    man['/'+f]=h; out.append({"key":h,"value":base64.b64encode(b).decode(),"metadata":{"contentType":ct.get(ext,'application/octet-stream')},"base64":True})
json.dump(man,open(w+'/manifest.json','w')); json.dump(out,open(w+'/payload.json','w'))
json.dump({"hashes":list(man.values())},open(w+'/hashes.json','w'))
PY
curl -s --noproxy '*' -X POST https://api.cloudflare.com/client/v4/pages/assets/upload -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" --data-binary @$W/payload.json >/dev/null
curl -s --noproxy '*' -X POST https://api.cloudflare.com/client/v4/pages/assets/upsert-hashes -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" --data-binary @$W/hashes.json >/dev/null
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$A/pages/projects/$P/deployments" -F "manifest=$(cat $W/manifest.json)" -F branch=main -F "_headers=@$SITE/_headers" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['success'],d['errors'],(d.get('result') or {}).get('url'))"
