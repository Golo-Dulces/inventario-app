import { useState } from 'react'
import { supabase } from '../supabaseClient'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function onLogin(e) {
    e.preventDefault()
    setLoading(true); setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) setError(error.message)
  }

  return (
    <div className="container" style={{ maxWidth: 520 }}>
      <h2>Inventario</h2>
      <div className="card">
        <form onSubmit={onLogin}>
          <div className="row">
            <input placeholder="Email" value={email} onChange={e=>setEmail(e.target.value)} style={{ flex: 1 }} />
            <input placeholder="Contraseña" type="password" value={password} onChange={e=>setPassword(e.target.value)} style={{ flex: 1 }} />
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="primary" disabled={loading}>
              {loading ? 'Entrando…' : 'Entrar'}
            </button>
          </div>
          {error && <p style={{ color: '#ffb4a2' }}>{error}</p>}
          <small className="muted">Tip: el usuario lo creaste en Supabase → Auth → Users.</small>
        </form>
      </div>
    </div>
  )
}
