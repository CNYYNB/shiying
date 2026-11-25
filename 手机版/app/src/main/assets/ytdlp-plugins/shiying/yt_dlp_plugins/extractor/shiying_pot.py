# 拾影 PO Token provider for yt-dlp (GPL-3.0, part of 拾影).
# The app mints YouTube PO tokens in a hidden WebView (assets/potoken.js) for every content binding yt-dlp may ask for
# (video id, visitor data, datasync id) and writes them to a JSON file; this provider only looks them up.
# Enable with: --plugin-dirs <dir> --extractor-args "youtubepot-shiying:file=<tokens.json>"
from __future__ import annotations

import json
import os
import time
import urllib.parse

from yt_dlp.extractor.youtube.pot.provider import (
    PoTokenContext,
    PoTokenProvider,
    PoTokenProviderRejectedRequest,
    PoTokenRequest,
    PoTokenResponse,
    register_preference,
    register_provider,
)
from yt_dlp.extractor.youtube.pot.utils import WEBPO_CLIENTS, get_webpo_content_binding

__version__ = '1.0.0'


@register_provider
class ShiyingPTP(PoTokenProvider):
    PROVIDER_NAME = 'shiying'
    PROVIDER_VERSION = __version__
    BUG_REPORT_LOCATION = '拾影'
    _SUPPORTED_CLIENTS = WEBPO_CLIENTS
    _SUPPORTED_CONTEXTS = (PoTokenContext.GVS, PoTokenContext.PLAYER, PoTokenContext.SUBS)
    _SUPPORTED_EXTERNAL_REQUEST_FEATURES = None  # makes no network requests (tokens come from a file)

    def _file(self):
        return (self._configuration_arg('file', [None], casesense=True) or [None])[0] or os.environ.get('SHIYING_POT_FILE')

    def is_available(self) -> bool:
        f = self._file()
        return bool(f) and os.path.isfile(f)

    def _real_request_pot(self, request: PoTokenRequest) -> PoTokenResponse:
        try:
            with open(self._file(), encoding='utf-8') as fp:
                data = json.load(fp)
        except Exception as e:
            raise PoTokenProviderRejectedRequest(f'cannot read token file: {e}')
        tokens = data.get('tokens') or {}
        binding, _ = get_webpo_content_binding(request)
        if not binding:
            raise PoTokenProviderRejectedRequest('no content binding')
        tok = tokens.get(binding) or tokens.get(urllib.parse.unquote(binding)) or tokens.get(urllib.parse.quote(binding, safe=''))
        if not tok:
            self.logger.debug(f'no token for binding {binding[:16]}…')
            raise PoTokenProviderRejectedRequest('no token for this binding')
        self.logger.debug(f'using token for binding {binding[:16]}…')
        return PoTokenResponse(po_token=tok, expires_at=int(data.get('expires') or time.time() + 3600))


@register_preference(ShiyingPTP)
def shiying_preference(provider, request):
    return 1000
