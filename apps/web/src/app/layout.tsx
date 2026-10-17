import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import { Providers } from '@/components/Providers'
import { Navbar } from '@/components/Navbar'

export const metadata: Metadata = {
  title: 'Fairhaven',
  description: 'Gated, pseudonymous, ephemeral boards on the Haven protocol stack.',
  icons: { icon: '/icon.svg' },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="daybreak" suppressHydrationWarning>
      <body>
        <Providers>
          <div className="container">
            <Navbar />
            {children}
          </div>
        </Providers>
      </body>
    </html>
  )
}
