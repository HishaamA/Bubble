import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CaptureDraftEditor } from './CaptureDraftEditor'

function editorProps() {
  return {
    previewUrl: 'blob:owned-by-controller',
    caption: 'Family dinner',
    sharing: false,
    error: '',
    annotationCount: 2,
    connectedFamilySync: true,
    captionInputRef: createRef<HTMLTextAreaElement>(),
    onCaptionChange: vi.fn(),
    onSubmit: vi.fn((event: React.FormEvent<HTMLFormElement>) => event.preventDefault()),
    onRemove: vi.fn(),
    onReview: vi.fn(),
  }
}

describe('CaptureDraftEditor', () => {
  it('keeps the textarea ref and current preview under the controller’s ownership', () => {
    const props = editorProps()
    render(<CaptureDraftEditor {...props} />)
    expect(props.captionInputRef.current).toBe(screen.getByRole('textbox'))
    expect(screen.getByRole('textbox')).toHaveValue('Family dinner')
    expect(screen.getByAltText('Preview of selected 360 panorama')).toHaveAttribute('src', props.previewUrl)
    expect(screen.getByText('2 memory points will appear inside this 360° moment.')).toBeInTheDocument()
  })

  it('forwards editor actions without independently clearing or saving the draft', async () => {
    const user = userEvent.setup()
    const props = editorProps()
    render(<CaptureDraftEditor {...props} />)
    await user.click(screen.getByRole('button', { name: 'Edit 360 & points' }))
    await user.click(screen.getByRole('button', { name: 'Remove selected panorama' }))
    await user.click(screen.getByRole('button', { name: 'Share with family' }))
    expect(props.onReview).toHaveBeenCalledTimes(1)
    expect(props.onRemove).toHaveBeenCalledTimes(1)
    expect(props.onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('textbox')).toHaveValue(props.caption)
  })

  it('keeps the caption controlled and follows the controller’s next value', async () => {
    const user = userEvent.setup()
    const props = editorProps()
    const view = render(<CaptureDraftEditor {...props} />)
    await user.type(screen.getByRole('textbox'), '!')
    expect(props.onCaptionChange).toHaveBeenLastCalledWith('Family dinner!')
    expect(screen.getByRole('textbox')).toHaveValue('Family dinner')
    view.rerender(<CaptureDraftEditor {...props} caption="Confirmed title" />)
    expect(screen.getByRole('textbox')).toHaveValue('Confirmed title')
  })

  it('locks draft mutation while sharing and preserves error and delivery copy', async () => {
    const user = userEvent.setup()
    const props = editorProps()
    render(<CaptureDraftEditor {...props} sharing error="Try again" connectedFamilySync={false} annotationCount={1} />)
    expect(screen.getByRole('textbox')).toBeDisabled()
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled()
      await user.click(button)
    }
    expect(props.onSubmit).not.toHaveBeenCalled()
    expect(props.onRemove).not.toHaveBeenCalled()
    expect(props.onReview).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Try again')
    expect(screen.getByText('1 memory point will appear inside this 360° moment.')).toBeInTheDocument()
    expect(screen.getByText('It’ll be saved to Memories on this device.')).toBeInTheDocument()
  })
})
