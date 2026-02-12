function ceilToStep(value, step = 1) {
  const v = Number(value)
  const s = Number(step)
  if (!Number.isFinite(v)) return null
  const k = Number.isFinite(s) && s > 0 ? s : 1
  return Math.ceil(v / k) * k
}

function roundToStep(value, step) {
  const n = Number(value)
  const s = Number(step)
  if (!Number.isFinite(n)) return null
  if (!Number.isFinite(s) || s <= 0) return n
  return Math.round((n + Number.EPSILON) / s) * s
}

function roundToStepMinPositive(value, step) {
  const rounded = roundToStep(value, step)
  const n = Number(value)
  const s = Number(step)
  if (rounded == null) return null
  if (Number.isFinite(n) && n > 0 && rounded <= 0 && Number.isFinite(s) && s > 0) return s
  return rounded
}

/**
 * calcPrecios
 * - redondeo: step para el redondeo de precios unitarios (antes de aplicar pack)
 * - Los precios finales (minorista/mayorista) se redondean al múltiplo de 50 más cercano
 * - Para 100g:
 *   - item.price_100g se interpreta como COSTO por 100g (manual/override), no como precio de venta.
 *   - item.margin_100g es el margen específico para calcular el precio de venta por 100g (si no está, cae a margen_minorista).
 */
export function calcPrecios(item, redondeo = 1) {
  // Pack (unid): lo aplicamos a minorista y mayorista
  const pack_unid = Math.max(1, Number(item.pack_mayorista_unid ?? 1) || 1)

  // 1) costo unitario
  let costo_unitario = null
  const costoManual = item.costo_unitario_manual ?? null

  if (costoManual != null && costoManual !== '' && Number(costoManual) > 0) {
    costo_unitario = Number(costoManual)
  } else {
    const bulk = Number(item.precio_bulto)
    const unid = Number(item.unid_por_bulto)
    if (Number.isFinite(bulk) && bulk > 0 && Number.isFinite(unid) && unid > 0) {
      costo_unitario = bulk / unid
    }
  }

  // 2) precios unitarios (sin pack)
  let minorista_unit = null
  let mayorista_unit = null

  const mMin = Number(item.margen_minorista)
  const mMay = Number(item.margen_mayorista)

  // Fórmula de margen (misma lógica que venías usando):
  // precio = costo / (1 - margen)
  if (costo_unitario != null && Number.isFinite(mMin) && mMin > 0 && mMin < 1) {
    minorista_unit = ceilToStep(costo_unitario / (1 - mMin), redondeo)
  }
  if (costo_unitario != null && Number.isFinite(mMay) && mMay > 0 && mMay < 1) {
    mayorista_unit = ceilToStep(costo_unitario / (1 - mMay), redondeo)
  }

  // 3) precios finales (aplicando pack)
  // ✅ Redondeo final a múltiplos de 50 (al más cercano)
  const stepFinal = 50
  const minorista =
    minorista_unit != null ? roundToStepMinPositive(minorista_unit * pack_unid, stepFinal) : null
  const mayorista =
    mayorista_unit != null ? roundToStepMinPositive(mayorista_unit * pack_unid, stepFinal) : null

  // 4) costo por 100g
  const esPorPeso = !!item.es_por_peso
  const pesoG = Number(item.peso_por_unidad_g)

  // price_100g = COSTO por 100g (override manual)
  let costo_100g =
    item.price_100g != null && item.price_100g !== '' ? Number(item.price_100g) : null

  // Si es por peso y no hay costo_100g manual, lo calculamos desde costo_unitario y peso.
  if (esPorPeso && (!Number.isFinite(costo_100g) || costo_100g <= 0)) {
    if (costo_unitario != null && Number.isFinite(pesoG) && pesoG > 0) {
      costo_100g = (Number(costo_unitario) / pesoG) * 100
    } else {
      costo_100g = null
    }
  }

  // 5) Precio venta por 100g (calc) NO lleva pack
  let venta_100g = null

  // margin_100g: margen específico (OBLIGATORIO si es por peso)
  const m100 =
    item.margin_100g != null && item.margin_100g !== '' ? Number(item.margin_100g) : NaN

  if (
    esPorPeso &&
    costo_100g != null &&
    Number.isFinite(costo_100g) &&
    costo_100g > 0 &&
    Number.isFinite(m100) &&
    m100 > 0 &&
    m100 < 1
  ) {
    // misma lógica de margen: precio = costo / (1 - margen)
    venta_100g = roundToStepMinPositive(costo_100g / (1 - m100), stepFinal)
  }

  return {
    pack_unid,
    costo_unitario,
    minorista_unit,
    mayorista_unit,
    minorista,
    mayorista,
    costo_100g,
    venta_100g,
  }
}
