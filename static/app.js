const tg = window.Telegram?.WebApp
if (tg) {
  tg.expand()
}

const $ = (id) => document.getElementById(id)

const statusEl = $('status')
const listEl = $('list')
const calcEl = $('calc')

function setStatus(text, kind = 'muted') {
  statusEl.className = `status ${kind}`
  statusEl.textContent = text
}

function initHeaders() {
  if (tg?.initData) {
    return { 'X-Tg-Init-Data': tg.initData }
  }
  return {}
}

function toIsoFromDatetimeLocal(value) {
  if (!value) return new Date().toISOString()
  return new Date(value).toISOString()
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU')
  } catch {
    return iso
  }
}

async function apiGetFuel(limit, vehicleId) {
  const qs = new URLSearchParams()
  if (limit) qs.set('limit', limit)
  if (vehicleId) qs.set('vehicle_id', vehicleId)

  const r = await fetch(`/api/fuel?${qs.toString()}`, {
    headers: initHeaders(),
  })

  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || r.status)
  }

  return r.json()
}

async function apiPostFuel(payload) {
  const r = await fetch('/api/fuel', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...initHeaders(),
    },
    body: JSON.stringify(payload),
  })

  if (!r.ok) {
    const t = await r.text()
    throw new Error(t || r.status)
  }
}

function computeConsumption(rows) {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.refuel_date) - new Date(b.refuel_date)
  )
  const fulls = sorted.filter((r) => r.is_full)

  if (fulls.length < 2) return null

  const last = fulls[fulls.length - 1]
  const prev = fulls[fulls.length - 2]

  const dist = last.mileage - prev.mileage
  if (dist <= 0) return null

  const between = sorted.filter(
    (r) =>
      new Date(r.refuel_date) > new Date(prev.refuel_date) &&
      new Date(r.refuel_date) <= new Date(last.refuel_date)
  )

  const liters = between.reduce((s, r) => s + Number(r.fuel_added || 0), 0)
  const cost = between.reduce(
    (s, r) => s + Number(r.fuel_added || 0) * Number(r.price_per_liter || 0),
    0
  )

  return {
    dist,
    liters,
    l100: (liters / dist) * 100,
    cost,
    costPerKm: cost / dist,
    from: prev.refuel_date,
    to: last.refuel_date,
  }
}

function render(rows) {
  listEl.innerHTML = ''
  calcEl.classList.add('hidden')

  if (!rows.length) {
    listEl.innerHTML = '<div class="muted">Нет данных</div>'
    return
  }

  const c = computeConsumption(rows)
  if (c) {
    calcEl.classList.remove('hidden')
    calcEl.innerHTML = `
      <b>Последний расход</b><br/>
      ${fmtDate(c.from)} → ${fmtDate(c.to)}<br/>
      Дистанция: <b>${c.dist.toFixed(0)} км</b><br/>
      Расход: <b>${c.l100.toFixed(2)} л/100км</b><br/>
      Цена/км: <b>${c.costPerKm.toFixed(3)}</b>
    `
  }

  rows
    .sort((a, b) => new Date(b.refuel_date) - new Date(a.refuel_date))
    .forEach((r) => {
      const el = document.createElement('div')
      el.className = 'entry'
      el.innerHTML = `
        <b>${r.vehicle_id}</b> #${r.id}<br/>
        ${fmtDate(r.refuel_date)} ${r.is_full ? '✓' : ''}<br/>
        ${r.mileage} км · ${r.fuel_added} л · ${r.price_per_liter}/л
      `
      listEl.appendChild(el)
    })
}

async function reload() {
  const vehicleId = $('vehicleId').value.trim()
  const limit = $('limit').value

  setStatus('Загрузка…')
  try {
    const rows = await apiGetFuel(limit, vehicleId)
    setStatus(`Ок: ${rows.length} записей`, 'ok')
    render(rows)
  } catch (e) {
    setStatus(`Ошибка: ${e.message}`, 'error')
  }
}

async function add() {
  const payload = {
    vehicle_id: $('vehicleId').value.trim(),
    mileage: Number($('mileage').value),
    fuel_added: Number($('fuelAdded').value),
    price_per_liter: Number($('pricePerLiter').value),
    is_full: $('isFull').value === 'true',
    refuel_date: toIsoFromDatetimeLocal($('refuelDate').value),
  }

  if (!payload.vehicle_id) {
    setStatus('vehicle_id обязателен', 'error')
    return
  }

  setStatus('Отправка…')
  try {
    await apiPostFuel(payload)
    setStatus('Добавлено', 'ok')
    await reload()
  } catch (e) {
    setStatus(`Ошибка: ${e.message}`, 'error')
  }
}

function initDate() {
  const d = new Date()
  $('refuelDate').value = d.toISOString().slice(0, 16)
}

$('reloadBtn').addEventListener('click', reload)
$('addBtn').addEventListener('click', add)

initDate()
reload()
