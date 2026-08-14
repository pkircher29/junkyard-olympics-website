import { api, subscribe } from './api.js';
import { demo } from './demo-data.js';

export const state = demo;
export const $ = (s, root=document) => root.querySelector(s);
export const $$ = (s, root=document) => [...root.querySelectorAll(s)];
export const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
export const params = new URLSearchParams(location.search);

export function initShell(surface) {
  document.body.dataset.surface = surface;
  if (api.demo) document.body.classList.add('demo-mode');
  if (api.demo) $$('a[href^="/"]').forEach(link => {
    const url = new URL(link.href);
    if (!url.search) link.href = `${url.pathname}?demo=1`;
  });
  const live = $('[data-connection]');
  if (live) live.innerHTML = `<span class="signal"></span>${api.demo ? 'DEMO FEED' : 'LOCAL LIVE'}`;
  subscribe(data => document.dispatchEvent(new CustomEvent('junkyard:update', { detail:data })));
  $$('[data-action="toast"]').forEach(button => button.addEventListener('click', () => toast(button.dataset.message || 'Saved to the scrap ledger.')));
}

export function toast(message) {
  let node = $('#toast');
  if (!node) { node=document.createElement('div'); node.id='toast'; node.className='toast'; node.setAttribute('role','status'); document.body.append(node); }
  node.textContent=message; node.classList.add('show'); clearTimeout(node._t); node._t=setTimeout(()=>node.classList.remove('show'),2600);
}

export function announce(text) {
  const audio = new Audio('/assets/junkyard-gong.wav');
  audio.volume = Number(localStorage.getItem('jo-volume') || .65);
  audio.play().catch(()=>{});
  if ('speechSynthesis' in window) {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices=speechSynthesis.getVoices();
    utterance.voice=voices.find(v=>/^en-GB/i.test(v.lang)) || voices.find(v=>/^en/i.test(v.lang)) || null;
    utterance.lang='en-GB'; utterance.rate=.91; utterance.pitch=.82; utterance.volume=audio.volume;
    setTimeout(()=>speechSynthesis.speak(utterance),480);
  }
}

export function qrMarkup(label='SCAN TO JOIN') {
  const station = /CHECK IN/i.test(label);
  const src = station ? '/assets/station-crusher-qr.png' : '/assets/signup-qr.png';
  return `<div class="qr-wrap" aria-label="${esc(label)}"><img src="${src}" alt="${esc(label)} QR code"><b>${esc(label)}</b></div>`;
}

export function setClock() {
  const update=()=>$$('[data-clock]').forEach(n=>n.textContent=new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit'}).format(new Date()));
  update(); setInterval(update,30000);
}
