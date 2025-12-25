const tg = window.Telegram?.WebApp
if (tg) tg.expand()

const $ = (id) => document.getElementById(id)

const statusEl = $('status')
const listEl = $('list')
const calcEl = $('calc')
const vehicleSelect = $('vehicleSelect')
const vehicleMeta = $('vehicleMeta')
const vehicleBadges = $('vehicleBadges')
const fuelGradeSel = $('fuelGrade')

let vehicles = []
let currentVehicle = null

const gradeUniverse = [
  '80', '92', '92+', '95', '95+', '98', '98+', '100',
  'D', 'DW', 'DA',
  'E10', 'E85',
  'H2', 'CNG', 'LPG',
]

function setStatus(text, kind = 'muted') {
  statusEl.className = `status ${kind}`
  statusEl.textContent = text
}

function initHeaders() {
  return tg?.initData ? { 'X-Tg-Init-Data': tg.initData } : {}
}

async function readError(r) {
  const ct = (r.headers.get('content-type') || '').toLowerCase()
  if (ct.includes('application/json')) {
    try {
      const j = await r.json()
      if (j?.detail?.code === 'CF_525') return 'Ошибка связи (Cloudflare 525): проверь TLS/сертификат на origin'
      return j?.detail ? JSON.stringify(j.detail) : JSON.stringify(j)
    } catch {
      return `HTTP ${r.status}`
    }
  }
  const t = await r.text().catch(() => '')
  if (t.includes('Error code 525') || t.includes('SSL handshake failed')) {
    return 'Ошибка связи (Cloudflare 525): проверь TLS/сертификат на origin'
  }
  return t || `HTTP ${r.status}`
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString('ru-RU')
  } catch {
    return iso
  }
}

function toIsoFromDatetimeLocal(value) {
  if (!value) return new Date().toISOString()
  return new Date(value).toISOString()
}

async function apiGetVehicles() {
  const r = await fetch('/api/vehicles', { headers: initHeaders() })
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}

async function apiGetFuel(limit, vehicleId) {
  const qs = new URLSearchParams()
  qs.set('limit', String(limit || 100))
  qs.set('vehicle_id', vehicleId)

  const r = await fetch(`/api/fuel?${qs.toString()}`, { headers: initHeaders() })
  if (!r.ok) throw new Error(await readError(r))
  return r.json()
}

async function apiPostFuel(payload) {
  const r = await fetch('/api/fuel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...initHeaders() },
    body: JSON.stringify(payload),
  })
  if (!r.ok) throw new Error(await readError(r))
}

function pickSavedVehicleId() {
  return localStorage.getItem('fuel_vehicle_id') || ''
}

function saveVehicleId(vhid) {
  localStorage.setItem('fuel_vehicle_id', vhid)
}

function setCurrentVehicleById(vhid) {
  currentVehicle = vehicles.find((v) => v.vehicle_id === vhid) || vehicles[0] || null
  if (!currentVehicle) return
  vehicleSelect.value = currentVehicle.vehicle_id
  saveVehicleId(currentVehicle.vehicle_id)
  renderVehicleHeader()
  renderFuelGrades()
}

function renderVehicleHeader() {
  if (!currentVehicle) {
    vehicleMeta.textContent = ''
    vehicleBadges.innerHTML = ''
    return
  }

  vehicleMeta.textContent = `${currentVehicle.vehicle_name} • ${currentVehicle.engine_type} ${currentVehicle.engine_cc}cc • бак ${currentVehicle.fuel_capacity}л (+${currentVehicle.allowed_overflow}л)`

  const planned = Number(currentVehicle.planned_consumption)
  const low = Number(currentVehicle.low_fuel_threshold)

  vehicleBadges.innerHTML = ''
  const b1 = document.createElement('div')
  b1.className = 'badge'
  b1.textContent = `план: ${Number.isFinite(planned) ? planned.toFixed(1) : '—'} л/100`
  vehicleBadges.appendChild(b1)

  const b2 = document.createElement('div')
  b2.className = 'badge'
  b2.textContent = `low fuel: ${Number.isFinite(low) ? low.toFixed(1) : '—'} л`
  vehicleBadges.appendChild(b2)

  const b3 = document.createElement('div')
  b3.className = 'badge'
  b3.textContent = `топливо: ${(currentVehicle.fuel_grade || []).join(', ') || '—'}`
  vehicleBadges.appendChild(b3)
}

function renderFuelGrades() {
  fuelGradeSel.innerHTML = ''
  const allowed = new Set((currentVehicle?.fuel_grade || []).map(String))

  gradeUniverse.forEach((g) => {
    const opt = document.createElement('option')
    opt.value = g
    opt.textContent = g
    if (!allowed.has(g)) opt.className = 'bad'
    fuelGradeSel.appendChild(opt)
  })

  const firstAllowed = (currentVehicle?.fuel_grade || [])[0]
  if (firstAllowed) fuelGradeSel.value = String(firstAllowed)
}

function computeConsumptionBetweenFulls(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.refuel_date) - new Date(b.refuel_date))
  const fulls = sorted.filter((x) => x.is_full === true)
  if (fulls.length < 2) return null

  const last = fulls[fulls.length - 1]
  const prev = fulls[fulls.length - 2]
  const dist = last.mileage - prev.mileage
  if (!(dist > 0)) return null

  const between = sorted.filter((x) => {
    const t = new Date(x.refuel_date).getTime()
    return t > new Date(prev.refuel_date).getTime() && t <= new Date(last.refuel_date).getTime()
  })

  const liters = between.reduce((s, x) => s + Number(x.fuel_added || 0), 0)
  const l100 = (liters / dist) * 100

  return { from: prev.refuel_date, to: last.refuel_date, dist, liters, l100 }
}

function consumptionBadge(cons) {
  const planned = Number(currentVehicle?.planned_consumption)
  if (!Number.isFinite(planned) || !cons) return { icon: '⚪️', text: 'нет плана' }

  const diff = (cons.l100 - planned) / planned
  const ad = Math.abs(diff)

  if (ad <= 0.07) return { icon: '🟢', text: 'норма' }
  if (ad <= 0.15) return { icon: diff > 0 ? '🟡⬆️' : '🟡⬇️', text: diff > 0 ? 'выше' : 'ниже' }
  return { icon: diff > 0 ? '🔴⬆️' : '🔴⬇️', text: diff > 0 ? 'сильно выше' : 'сильно ниже' }
}

function render(rows) {
  listEl.innerHTML = ''
  calcEl.classList.add('hidden')

  if (!Array.isArray(rows) || rows.length === 0) {
    listEl.innerHTML = '<div class="muted">Нет записей</div>'
    return
  }

  const cons = computeConsumptionBetweenFulls(rows)
  if (cons) {
    const b = consumptionBadge(cons)
    calcEl.classList.remove('hidden')
    calcEl.innerHTML = `
      <b>Расход между "полный бак"</b><br/>
      ${fmtDate(cons.from)} → ${fmtDate(cons.to)}<br/>
      Дистанция: <b>${cons.dist.toFixed(0)} км</b><br/>
      Топливо: <b>${cons.liters.toFixed(2)} л</b><br/>
      Расход: <b>${cons.l100.toFixed(2)} л/100км</b> ${b.icon} <span class="muted">${b.text}</span>
    `
  }

  rows
    .sort((a, b) => new Date(b.refuel_date) - new Date(a.refuel_date))
    .forEach((r) => {
      const cost = Number(r.fuel_added || 0) * Number(r.price_per_liter || 0)
      const el = document.createElement('div')
      el.className = 'entry'
      el.innerHTML = `
        <b>${r.vehicle_id}</b> <span class="muted">#${r.id ?? ''}</span><br/>
        ${fmtDate(r.refuel_date)} ${r.is_full ? '✅ полный' : '⚪️'}<br/>
        ${r.mileage} км · ${Number(r.fuel_added).toFixed(2)} л · ${Number(r.price_per_liter).toFixed(2)}/л · <b>${cost.toFixed(2)}</b>
        ${r.fuel_grade ? `<br/><span class="muted">топливо: ${r.fuel_grade}</span>` : ''}
      `
      listEl.appendChild(el)
    })
}

async function reload() {
  if (!currentVehicle) return
  const limit = Number($('limit').value || 100)
  setStatus('Загружаю…')
  try {
    const rows = await apiGetFuel(limit, currentVehicle.vehicle_id)
    setStatus(`Ок: ${rows.length} записей`, 'ok')
    render(rows)
  } catch (e) {
    setStatus(`Ошибка: ${e.message}`, 'error')
  }
}

async function add() {
  if (!currentVehicle) return

  const payload = {
    vehicle_id: currentVehicle.vehicle_id,
    mileage: Number($('mileage').value),
    fuel_added: Number($('fuelAdded').value),
    price_per_liter: Number($('pricePerLiter').value),
    fuel_grade: fuelGradeSel.value,
    is_full: $('isFull').checked,
    refuel_date: toIsoFromDatetimeLocal($('refuelDate').value),
  }

  if (!Number.isFinite(payload.mileage) || !Number.isFinite(payload.fuel_added) || !Number.isFinite(payload.price_per_liter)) {
    setStatus('Проверь mileage / fuel_added / price_per_liter', 'error')
    return
  }

  setStatus('Отправляю…')
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

async function bootstrap() {
  setStatus('Загружаю список машин…')
  try {
    vehicles = await apiGetVehicles()
    if (!Array.isArray(vehicles) || vehicles.length === 0) {
      setStatus('Нет доступных машин (fuel-vhid вернул пусто)', 'error')
      return
    }

    vehicleSelect.innerHTML = ''
    vehicles.forEach((v) => {
      const opt = document.createElement('option')
      opt.value = v.vehicle_id
      opt.textContent = `${v.vehicle_name} (${v.vehicle_id})`
      vehicleSelect.appendChild(opt)
    })

    const saved = pickSavedVehicleId()
    setCurrentVehicleById(saved || vehicles[0].vehicle_id)

    setStatus('Ок', 'ok')
    await reload()
  } catch (e) {
    setStatus(`Ошибка: ${e.message}`, 'error')
  }
}

vehicleSelect.addEventListener('change', async () => {
  setCurrentVehicleById(vehicleSelect.value)
  await reload()
})

$('reloadBtn').addEventListener('click', reload)
$('addBtn').addEventListener('click', add)

initDate()
bootstrap()