import { Mark } from '@/components/Mark'

export default function ExpiredPage() {
  return (
    <div className="notice">
      <div style={{ color: 'var(--border)' }}>
        <Mark size={48} />
      </div>
      <h1>Thread expired</h1>
      <p>Its index record and key are gone. There is no archive.</p>
    </div>
  )
}
