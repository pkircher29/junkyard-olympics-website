export function createSignupFlow(events = []) {
  return {
    step: 'name',
    displayName: '',
    events: events.filter(event => event.available !== 0),
    selected: new Set(),
  };
}

export function advanceToEvents(flow, value) {
  const displayName = String(value ?? '').trim();
  if (!displayName) throw new Error('Enter a display name so we know what to call you.');
  return { ...flow, step: 'events', displayName };
}

export function toggleEvent(flow, eventId) {
  if (!flow.events.some(event => event.id === eventId)) return flow;
  const selected = new Set(flow.selected);
  if (selected.has(eventId)) selected.delete(eventId);
  else selected.add(eventId);
  return { ...flow, selected };
}

export function cannonId(flow) {
  return flow.events.find(event => event.kind?.toLowerCase() === 'cannon' || event.id === 'cannon')?.id ?? null;
}

export function canEnter(flow) {
  const required = cannonId(flow);
  return flow.step === 'events' && Boolean(required && flow.selected.has(required));
}
