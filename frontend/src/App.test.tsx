import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'

describe('App', () => {
  it('renders the agentos placeholder', () => {
    render(<App />)
    expect(screen.getByText('agentos')).toBeInTheDocument()
  })
})
