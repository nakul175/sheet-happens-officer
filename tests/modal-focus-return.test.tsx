// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { Modal } from '@/components/ui';
let root: Root;
function Fixture() {
  const [open, setOpen] = useState(false), [nested, setNested] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open form</button>{open && <Modal label="Form" onClose={() => setOpen(false)}><input autoFocus aria-label="Title"/><button onClick={() => setNested(true)}>Open confirmation</button><button onClick={() => setOpen(false)}>Cancel</button>{nested && <Modal label="Confirm" onClose={() => setNested(false)}><input autoFocus aria-label="Reason"/></Modal>}</Modal>}</>;
}
async function mount() { document.body.innerHTML='<div id="root"></div>'; await act(async () => { root=createRoot(document.getElementById('root')!); root.render(<Fixture/>); }); }
async function click(text: string) { const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!; button.focus(); await act(async()=>button.click()); return button; }
async function escape() { await act(async()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))); }
afterEach(()=>{act(()=>root?.unmount());document.body.innerHTML='';});
it('restores the invoking control after an autofocus form closes with Escape',async()=>{
  await mount();const opener=await click('Open form');expect(document.querySelector('[role="dialog"]')).not.toBeNull();await escape();expect(document.querySelector('[role="dialog"]')).toBeNull();expect(document.activeElement).toBe(opener);
});
it('returns from nested confirmation to its trigger, then Cancel to the original invoker',async()=>{
  await mount();
  const opener=await click('Open form');
  const nested=await click('Open confirmation');
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  await escape();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.activeElement).toBe(nested);
  expect(document.body.style.overflow).toBe('hidden');
  expect(document.body.classList.contains('vv-sheet')).toBe(true);
  await click('Cancel');
  expect(document.activeElement).toBe(opener);
  expect(document.body.classList.contains('vv-sheet')).toBe(false);
});
