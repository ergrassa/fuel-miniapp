import hashlib
import hmac
import json
import os
import time
from typing import Any, Optional
from urllib.parse import parse_qsl

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()
DEV_MODE = os.environ.get('DEV_MODE', '').lower() in ('1', 'true', 'yes')
DEV_USER_ID = os.environ.get('DEV_USER_ID')
N8N_BASE_URL = os.environ.get('N8N_BASE_URL')
WEBHOOK_PATH_FUEL = os.environ.get('WEBHOOK_PATH_FUEL')
WEBHOOK_PATH_VEHICLES = os.environ.get('WEBHOOK_PATH_VEHICLES')
N8N_WEBHOOK_TOKEN = os.environ.get('N8N_WEBHOOK_TOKEN')
TG_BOT_TOKEN = os.environ.get('TG_BOT_TOKEN')

app = FastAPI()
app.mount('/static', StaticFiles(directory='static'), name='static')


def _require_env() -> None:
  missing = []
  if not N8N_BASE_URL:
    missing.append('N8N_BASE_URL')
  if not WEBHOOK_PATH_FUEL:
    missing.append('WEBHOOK_PATH_FUEL')
  if not WEBHOOK_PATH_VEHICLES:
    missing.append('WEBHOOK_PATH_VEHICLES')
  if not N8N_WEBHOOK_TOKEN:
    missing.append('N8N_WEBHOOK_TOKEN')
  if not TG_BOT_TOKEN:
    missing.append('TG_BOT_TOKEN')
  if missing:
    raise RuntimeError(f'Missing env: {", ".join(missing)}')


def _join_url(base: str, path: str) -> str:
  return base.rstrip('/') + '/' + path.lstrip('/')


def _is_cloudflare_525(body: str) -> bool:
  return 'SSL handshake failed' in body and 'Error code 525' in body


def _validate_init_data(init_data: str, max_age_sec: int = 24 * 60 * 60) -> dict[str, str]:
  if not init_data:
    raise HTTPException(status_code=401, detail='Missing Telegram init data')

  pairs = dict(parse_qsl(init_data, keep_blank_values=True))
  received_hash = pairs.pop('hash', None)
  if not received_hash:
    raise HTTPException(status_code=401, detail='Missing hash in init data')

  auth_date_str = pairs.get('auth_date')
  if not auth_date_str or not auth_date_str.isdigit():
    raise HTTPException(status_code=401, detail='Missing auth_date in init data')

  auth_date = int(auth_date_str)
  now = int(time.time())
  if now - auth_date > max_age_sec:
    raise HTTPException(status_code=401, detail='initData is too old')

  data_check_string = '\n'.join([f'{k}={v}' for k, v in sorted(pairs.items(), key=lambda x: x[0])])

  secret_key = hmac.new(
    key=b'WebAppData',
    msg=TG_BOT_TOKEN.encode('utf-8'),
    digestmod=hashlib.sha256,
  ).digest()

  calculated_hash = hmac.new(
    key=secret_key,
    msg=data_check_string.encode('utf-8'),
    digestmod=hashlib.sha256,
  ).hexdigest()

  if not hmac.compare_digest(calculated_hash, received_hash):
    raise HTTPException(status_code=401, detail='Bad init data signature')

  return pairs


def _get_user_id(pairs: Optional[dict[str, str]]) -> str:
  if DEV_MODE:
    if not DEV_USER_ID:
      raise RuntimeError('DEV_MODE enabled but DEV_USER_ID is not set')
    return str(DEV_USER_ID)

  if not pairs:
    raise HTTPException(status_code=401, detail='Missing Telegram init data')

  user_raw = pairs.get('user')
  if not user_raw:
    raise HTTPException(status_code=401, detail='No user in init data')

  try:
    user = json.loads(user_raw)
  except Exception:
    raise HTTPException(status_code=401, detail='Bad user payload in init data')

  user_id = user.get('id')
  if isinstance(user_id, int):
    return str(user_id)
  if isinstance(user_id, str) and user_id.strip():
    return user_id.strip()

  raise HTTPException(status_code=401, detail='No user id in init data')


async def _proxy_get(url: str, params: dict[str, Any]) -> Any:
  async with httpx.AsyncClient(timeout=20) as client:
    r = await client.get(url, params=params, headers={'X-Auth-Token': N8N_WEBHOOK_TOKEN})

  ct = (r.headers.get('content-type') or '').lower()
  text = r.text

  if r.status_code >= 400:
    if r.status_code == 525 or _is_cloudflare_525(text):
      raise HTTPException(status_code=503, detail={'code': 'CF_525', 'message': 'Upstream SSL handshake failed'})
    raise HTTPException(status_code=r.status_code, detail={'code': 'UPSTREAM_ERROR', 'message': text[:400]})

  if 'application/json' not in ct:
    if _is_cloudflare_525(text):
      raise HTTPException(status_code=503, detail={'code': 'CF_525', 'message': 'Upstream SSL handshake failed'})
    raise HTTPException(
      status_code=502,
      detail={'code': 'BAD_UPSTREAM_CONTENT', 'message': f'Expected JSON, got {ct or "unknown"}'},
    )

  return r.json()


async def _proxy_post(url: str, payload: dict[str, Any]) -> Any:
  async with httpx.AsyncClient(timeout=20) as client:
    r = await client.post(url, json=payload, headers={'X-Auth-Token': N8N_WEBHOOK_TOKEN})

  ct = (r.headers.get('content-type') or '').lower()
  text = r.text

  if r.status_code >= 400:
    if r.status_code == 525 or _is_cloudflare_525(text):
      raise HTTPException(status_code=503, detail={'code': 'CF_525', 'message': 'Upstream SSL handshake failed'})
    raise HTTPException(status_code=r.status_code, detail={'code': 'UPSTREAM_ERROR', 'message': text[:400]})

  if 'application/json' in ct:
    try:
      return r.json()
    except Exception:
      return {'ok': True}

  if _is_cloudflare_525(text):
    raise HTTPException(status_code=503, detail={'code': 'CF_525', 'message': 'Upstream SSL handshake failed'})

  return {'ok': True}


@app.get('/')
async def index():
  return FileResponse('static/index.html')


@app.get('/api/vehicles')
async def get_vehicles(
  vehicle_id: Optional[str] = None,
  x_tg_init_data: Optional[str] = Header(default=None, alias='X-Tg-Init-Data'),
):
  _require_env()
  pairs = None
  if not DEV_MODE:
    pairs = _validate_init_data(x_tg_init_data or '')

  user_id = _get_user_id(pairs)

  url = _join_url(N8N_BASE_URL, WEBHOOK_PATH_VEHICLES)
  params: dict[str, Any] = {'user_id': user_id}
  if vehicle_id:
    params['vehicle_id'] = vehicle_id

  data = await _proxy_get(url, params)
  return JSONResponse(content=data)


@app.get('/api/fuel')
async def get_fuel(
  limit: int = 100,
  vehicle_id: Optional[str] = None,
  x_tg_init_data: Optional[str] = Header(default=None, alias='X-Tg-Init-Data'),
):
  _require_env()
  pairs = None
  if not DEV_MODE:
    pairs = _validate_init_data(x_tg_init_data or '')

  user_id = _get_user_id(pairs)

  if not vehicle_id:
    raise HTTPException(status_code=400, detail='vehicle_id is required')

  url_v = _join_url(N8N_BASE_URL, WEBHOOK_PATH_VEHICLES)
  vehicles = await _proxy_get(url_v, {'user_id': user_id, 'vehicle_id': vehicle_id})
  if not vehicles:
    raise HTTPException(status_code=403, detail='Vehicle is not allowed')

  url = _join_url(N8N_BASE_URL, WEBHOOK_PATH_FUEL)
  params: dict[str, Any] = {'limit': limit, 'vehicle_id': vehicle_id}
  data = await _proxy_get(url, params)
  return JSONResponse(content=data)


@app.post('/api/fuel')
async def post_fuel(
  request: Request,
  x_tg_init_data: Optional[str] = Header(default=None, alias='X-Tg-Init-Data'),
):
  _require_env()
  pairs = None
  if not DEV_MODE:
    pairs = _validate_init_data(x_tg_init_data or '')

  user_id = _get_user_id(pairs)

  payload = await request.json()
  vehicle_id = payload.get('vehicle_id')
  if not isinstance(vehicle_id, str) or not vehicle_id:
    raise HTTPException(status_code=400, detail='vehicle_id is required')

  url_v = _join_url(N8N_BASE_URL, WEBHOOK_PATH_VEHICLES)
  vehicles = await _proxy_get(url_v, {'user_id': user_id, 'vehicle_id': vehicle_id})
  if not vehicles:
    raise HTTPException(status_code=403, detail='Vehicle is not allowed')

  url = _join_url(N8N_BASE_URL, WEBHOOK_PATH_FUEL)
  data = await _proxy_post(url, payload)
  return JSONResponse(content=data)
