import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../supabaseClient'
import { recalcularCompuestos } from '../lib/recalcCompuestos'
import { calcPrecios } from '../lib/pricing'

export default function Products({ user }) {
  const [products, setProducts] = useState([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [redondeo, setRedondeo] = useState(1)
  const [statusFilter, setStatusFilter] = useState('all')

  const [recalcInfo, setRecalcInfo] = useState(null)
  const [recalcLoading, setRecalcLoading] = useState(false)
  const [publishingTN, setPublishingTN] = useState(false)

  const getProductView = p => {
    const calcItem =
      p?.es_compuesto
        ? { ...p, costo_unitario_manual: p.costo_compuesto_cache ?? p.costo_unitario_manual }
        : p
    const pp = calcPrecios(calcItem, redondeo)
    const pendingCompositeCost =
      p?.es_compuesto && (p?.costo_compuesto_cache == null || Number.isNaN(Number(p?.costo_compuesto_cache)))
    const noCost = pp?.minorista == null && pp?.mayorista == null
    const noSku = Number(p?._missingSkuCount ?? 0) > 0
    const noTnMatch = Number(p?._missingTnCount ?? 0) > 0
    const stockMin = Number(p?.stock_minimo)
    const stock = Number(p?._stock)
    const lowStock = Number.isFinite(stockMin) && stockMin > 0 && Number.isFinite(stock) && stock < stockMin
    const statuses = []
    if (pendingCompositeCost) statuses.push('Pendiente recalc')
    if (noCost) statuses.push('Sin costo')
    if (noSku) statuses.push('Sin SKU')
    if (noTnMatch) statuses.push('Sin match TN')
    if (lowStock) statuses.push('Stock bajo')
    if (statuses.length === 0) statuses.push('OK')

    return { pp, pendingCompositeCost, statuses }
  }

  async function loadRedondeo() {
    const { data, error } = await supabase
      .from('parametros')
      .select('valor')
      .eq('clave', 'redondeo')
      .maybeSingle()
    if (!error) {
      const r = data?.valor ? Number(data.valor) : 1
      setRedondeo(Number.isFinite(r) ? r : 1)
    }
  }

  async function loadProducts() {
    setLoading(true)
    const { data, error } = await supabase
      .from('items')
      .select(
        'id,nombre,categoria,tipo_producto,marca,updated_at,' +
        'es_compuesto,costo_compuesto_cache,' +
        'costo_unitario_manual,unid_por_bulto,precio_bulto,stock_minimo,' +
        'margen_minorista,margen_mayorista,pack_mayorista_unid,tn_stock'
      )
      .eq('tipo', 'producto')
      .eq('owner_id', user.id)
      .order('nombre', { ascending: true })

    if (error) {
      setLoading(false)
      alert(error.message)
      return
    }

    const { data: variantStocks, error: variantErr } = await supabase
      .from('items')
      .select('parent_id,tn_stock,sku,tn_variant_id')
      .eq('tipo', 'variante')
      .eq('owner_id', user.id)

    if (variantErr) {
      console.error('loadProducts variant stock error', variantErr)
    }

    const variantByParent = new Map()
    for (const v of variantStocks || []) {
      const parentId = Number(v.parent_id)
      if (!Number.isFinite(parentId)) continue

      if (!variantByParent.has(parentId)) {
        variantByParent.set(parentId, {
          stock: 0,
          hasStock: false,
          variants: 0,
          missingSku: 0,
          missingTn: 0,
        })
      }
      const agg = variantByParent.get(parentId)
      agg.variants += 1

      const sku = String(v.sku ?? '').trim()
      if (!sku) {
        agg.missingSku += 1
      } else if (v.tn_variant_id == null || v.tn_variant_id === '') {
        agg.missingTn += 1
      }

      const s = Number(v.tn_stock)
      if (Number.isFinite(s)) {
        agg.stock += s
        agg.hasStock = true
      }
    }

    const mapped = (data || []).map(p => {
      const agg = variantByParent.get(p.id)
      const stockFromVariants = agg?.hasStock ? agg.stock : null
      const fallback = Number(p.tn_stock)
      const stock = Number.isFinite(stockFromVariants)
        ? stockFromVariants
        : (Number.isFinite(fallback) ? fallback : null)
      return {
        ...p,
        _stock: stock,
        _variantCount: agg?.variants ?? 0,
        _missingSkuCount: agg?.missingSku ?? 0,
        _missingTnCount: agg?.missingTn ?? 0,
      }
    })

    setProducts(mapped)
    setLoading(false)
  }

  useEffect(() => {
    if (!user?.id) return
    loadRedondeo()
    loadProducts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    const matchesSearch = p =>
      !s ||
      (p.nombre || '').toLowerCase().includes(s) ||
      (p.categoria || '').toLowerCase().includes(s) ||
      (p.marca || '').toLowerCase().includes(s)

    const matchesStatus = p => {
      const calcItem =
        p?.es_compuesto
          ? { ...p, costo_unitario_manual: p.costo_compuesto_cache ?? p.costo_unitario_manual }
          : p
      const pp = calcPrecios(calcItem, redondeo)
      const pendingRecalc = p?.es_compuesto && (p?.costo_compuesto_cache == null || Number.isNaN(Number(p?.costo_compuesto_cache)))
      const noCost = pp?.minorista == null && pp?.mayorista == null
      const noSku = Number(p?._missingSkuCount ?? 0) > 0
      const noTnMatch = Number(p?._missingTnCount ?? 0) > 0
      const stockMin = Number(p?.stock_minimo)
      const stock = Number(p?._stock)
      const lowStock = Number.isFinite(stockMin) && stockMin > 0 && Number.isFinite(stock) && stock < stockMin
      const hasIssues = pendingRecalc || noCost || noSku || noTnMatch || lowStock

      if (statusFilter === 'all') return true
      if (statusFilter === 'ok') return !hasIssues
      if (statusFilter === 'issues') return hasIssues
      if (statusFilter === 'pending_recalc') return pendingRecalc
      if (statusFilter === 'no_cost') return noCost
      if (statusFilter === 'no_sku') return noSku
      if (statusFilter === 'no_tn_match') return noTnMatch
      if (statusFilter === 'low_stock') return lowStock
      return true
    }

    return products.filter(p => matchesSearch(p) && matchesStatus(p))
  }, [products, q, statusFilter, redondeo])

  async function createProduct() {
    const nombre = prompt('Nombre del producto:')
    if (!nombre) return
    const { error } = await supabase.from('items').insert([
      {
        tipo: 'producto',
        nombre,
        owner_id: user.id,
        margen_minorista: 0,
        margen_mayorista: 0,
        pack_mayorista_unid: 1,
      },
    ])
    if (!error) loadProducts()
    else alert(error.message)
  }

  async function onRecalcular() {
    setRecalcLoading(true)
    setRecalcInfo(null)
    try {
      const res = await recalcularCompuestos({ ownerId: user.id })
      setRecalcInfo(res)
      await loadProducts()
    } catch (e) {
      alert(e?.message || String(e))
    } finally {
      setRecalcLoading(false)
    }
  }

  async function publishAllToTN() {
    try {
      setPublishingTN(true)

      const { data, error } = await supabase.auth.getSession()
      if (error) throw error

      const accessToken = data?.session?.access_token
      if (!accessToken || accessToken.split('.').length !== 3) {
        alert('No hay sesion valida. Cerra sesion y volve a entrar.')
        return
      }

      console.info('[push-tn-prices][all] request start', { ownerId: user?.id })

      const { data: json, error: fnError } = await supabase.functions.invoke('push-tn-prices', {
        body: { scope: 'all' },
      })

      if (fnError) {
        let detail = fnError.message ?? 'Error'
        if (fnError.context) {
          const errJson = await fnError.context.json().catch(() => null)
          if (errJson?.error) detail = errJson.error
          console.error('[push-tn-prices][all] request failed (http)', { fnError, errJson })
        } else {
          console.error('[push-tn-prices][all] request failed', fnError)
        }
        alert(`Error: ${detail}`)
        return
      }

      console.info('[push-tn-prices][all] request ok', json)
      if (json?.ok === false) {
        const updated = Number(json?.variants_updated ?? 0)
        const failed = Number(json?.failed_products?.length ?? 0)
        const firstError = json?.failed_products?.[0]?.error
        alert(`Publicacion parcial. Variantes actualizadas: ${updated}. Productos fallidos: ${failed}.${firstError ? ` Primer error: ${firstError}` : ''}`)
        return
      }
      if (Number(json?.variants_updated ?? 0) === 0) {
        const missingSku = Number(json?.missingSkuLocal?.length ?? 0)
        const missingInTN = Number(json?.missingInTN?.length ?? 0)
        const skippedNoPrice = Number(json?.skippedNoPrice?.length ?? 0)
        const firstSkipped = json?.skippedNoPrice?.[0]
        const detail = firstSkipped
          ? ` Primer skipped: id=${firstSkipped.local_variant_id}, sku=${firstSkipped.sku || '-'}, reason=${firstSkipped.reason}.`
          : ''
        alert(`Sin cambios para publicar. missingSkuLocal=${missingSku}, missingInTN=${missingInTN}, skippedNoPrice=${skippedNoPrice}.${detail}`)
        return
      }
      alert(`Listo. Variantes actualizadas: ${json?.variants_updated ?? 0}`)
    } catch (e) {
      console.error('[push-tn-prices][all] unexpected error', e)
      alert(e?.message ?? String(e))
    } finally {
      setPublishingTN(false)
    }
  }

  return (
    <div className="container">
      <div className="row products-header">
        <h2 style={{ margin: 0 }}>Productos</h2>
        <div className="row products-actions">
          <span className="pill">Redondeo: {redondeo}</span>
          <button onClick={onRecalcular} disabled={recalcLoading}>
            {recalcLoading ? 'Recalculando...' : 'Recalcular compuestos'}
          </button>
          <button onClick={publishAllToTN} disabled={publishingTN}>
            {publishingTN ? 'Publicando TN...' : 'Publicar precios (TN)'}
          </button>
          <button className="primary" onClick={createProduct}>
            + Nuevo
          </button>
        </div>
      </div>

      {recalcInfo && (
        <div className="card" style={{ marginTop: 12 }}>
          <small className="muted">
            Recalc: {JSON.stringify(recalcInfo)}
          </small>
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row products-filters">
          <input placeholder="Buscar..." value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1 }} />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">Estado: Todos</option>
            <option value="ok">Solo OK</option>
            <option value="issues">Solo con problemas</option>
            <option value="pending_recalc">Pendiente recalc</option>
            <option value="no_cost">Sin costo</option>
            <option value="no_sku">Sin SKU</option>
            <option value="no_tn_match">Sin match TN</option>
            <option value="low_stock">Stock bajo</option>
          </select>
          <button onClick={loadProducts}>Actualizar</button>
        </div>

        {loading ? (
          <p>Cargando...</p>
        ) : (
          <>
            <div className="table-wrap products-table-desktop">
              <table className="table" style={{ marginTop: 10 }}>
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Categoria</th>
                    <th>Tipo</th>
                    <th>Marca</th>
                    <th>Minorista</th>
                    <th>Mayorista</th>
                    <th>Stock</th>
                    <th>Estado</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(p => {
                    const { pp, pendingCompositeCost, statuses } = getProductView(p)
                    return (
                      <tr key={p.id}>
                        <td>{p.nombre}</td>
                        <td>{p.categoria || <small className="muted">-</small>}</td>
                        <td>{p.tipo_producto || <small className="muted">-</small>}</td>
                        <td>{p.marca || <small className="muted">-</small>}</td>
                        <td>
                          {pp?.minorista ?? (
                            pendingCompositeCost
                              ? <small className="muted">Pendiente recalc</small>
                              : <small className="muted">-</small>
                          )}
                        </td>
                        <td>
                          {pp?.mayorista ?? (
                            pendingCompositeCost
                              ? <small className="muted">Pendiente recalc</small>
                              : <small className="muted">-</small>
                          )}
                        </td>
                        <td>{p._stock ?? <small className="muted">-</small>}</td>
                        <td>
                          <small className="muted">{statuses.join(' | ')}</small>
                        </td>
                        <td>
                          <Link to={`/p/${p.id}`}>
                            <button>Editar</button>
                          </Link>
                        </td>
                      </tr>
                    )
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan="9">
                        <small className="muted">Sin resultados</small>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="products-mobile-list" style={{ marginTop: 10 }}>
              {filtered.map(p => {
                const { pp, pendingCompositeCost, statuses } = getProductView(p)
                const minorista = pp?.minorista ?? (pendingCompositeCost ? 'Pendiente recalc' : '-')
                const mayorista = pp?.mayorista ?? (pendingCompositeCost ? 'Pendiente recalc' : '-')
                return (
                  <div key={p.id} className="card product-mobile-card">
                    <div className="row product-mobile-head" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                      <strong className="product-mobile-name">{p.nombre}</strong>
                      <Link to={`/p/${p.id}`}>
                        <button>Editar</button>
                      </Link>
                    </div>
                    <small className="muted product-mobile-meta">
                      {p.categoria || '-'} | {p.tipo_producto || '-'} | {p.marca || '-'}
                    </small>
                    <div className="row product-mobile-prices" style={{ marginTop: 8 }}>
                      <span className="pill">Minorista: {minorista}</span>
                      <span className="pill">Mayorista: {mayorista}</span>
                      <span className="pill">Stock: {p._stock ?? '-'}</span>
                    </div>
                    <small className="muted product-mobile-status" style={{ display: 'block', marginTop: 8 }}>
                      Estado: {statuses.join(' | ')}
                    </small>
                  </div>
                )
              })}
              {filtered.length === 0 && (
                <small className="muted">Sin resultados</small>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
