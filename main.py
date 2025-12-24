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

N8N_WEBHOOK_URL = os.environ.get('N8N_WEBHOOK_URL')
N8N_WEBHOOK_TOKEN = os.environ.get('N8N_WEBHOOK_TOKEN')
TG_BOT_TOKEN = os.environ.get('TG_BOT_TOKEN')

app = FastAPI()


def _require_env() -> None:
  if not N8N_WEBHOOK_URL:
    raise RuntimeError('N8N_WEBHOOK_URL is not set')
  if not N8N_WEBHOOK_TOKEN:
    raise RuntimeError('N8N_WEBHOOK_TOKEN is not set')
  if not TG_BOT_TOKEN:
    raise RuntimeError('TG_BOT_TOKEN is not set')


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

  secret_key = hashlib.sha256(TG_BOT_TOKEN.encode('utf-8')).digest()
  calculated_hash = hmac.new(secret_key, data_check_string.encode('utf-8'), hashlib.sha256).hexdigest()

  if not hmac.compare_digest(calculated_hash, received_hash):
    raise HTTPException(status_code=401, detail='Bad init data signature')

  return pairs


def _require_user(pairs: dict[str, str]) -> dict[str, Any]:
  user_raw = pairs.get('user')
  if not user_raw:
    raise HTTPException(status_code=401, detail='No user in init data')
  try:
    return json.loads(user_raw)
  except Exception:
    raise HTTPException(status_code=401, detail='Bad user payload in init data')


async def _proxy_get(params: dict[str, Any]) -> Any:
  async with httpx.AsyncClient(timeout=20) as client:
    r = await client.get(
      N8N_WEBHOOK_URL,
      params=params,
      headers={'X-Auth-Token': N8N_WEBHOOK_TOKEN},
    )
  if r.status_code >= 400:
    raise HTTPException(status_code=r.status_code, detail=r.text)
  return r.json()


async def _proxy_post(payload: dict[str, Any]) -> Any:
  async with httpx.AsyncClient(timeout=20) as client:
    r = await client.post(
      N8N_WEBHOOK_URL,
      json=payload,
      headers={'X-Auth-Token': N8N_WEBHOOK_TOKEN},
    )
  if r.status_code >= 400:
    raise HTTPException(status_code=r.status_code, detail=r.text)
  try:
    return r.json()
  except Exception:
    return {'ok': True}


@app.get('/')
async def index():
  return FileResponse('static/index.html')


@app.get('/api/fuel')
async def get_fuel(
  limit: int = 100,
  vehicle_id: Optional[str] = None,
  x_tg_init_data: Optional[str] = Header(default=None, alias='X-Tg-Init-Data'),
):
  _require_env()
  pairs = _validate_init_data(x_tg_init_data or '')
  _require_user(pairs)

  params: dict[str, Any] = {'limit': limit}
  if vehicle_id:
    params['vehicle_id'] = vehicle_id

  data = await _proxy_get(params)
  return JSONResponse(content=data)


@app.post('/api/fuel')
async def post_fuel(
  request: Request,
  x_tg_init_data: Optional[str] = Header(default=None, alias='X-Tg-Init-Data'),
):
  _require_env()
  pairs = _validate_init_data(x_tg_init_data or '')
  _require_user(pairs)

  payload = await request.json()
  data = await _proxy_post(payload)
  return JSONResponse(content=data)


app.mount('/static', StaticFiles(directory='static'), name='static')
