/**
 * SecondShift data store — JSON-file backed (zero native deps).
 * Collections: automations (the crew), leads (deal briefs), events (test-drive analytics),
 * clients + invoices (billing), calls + appointments (The Voice),
 * leadThreads (First Response), contents (Content Crew).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cloud = require('./cloud-store');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.SECONDSHIFT_DB || path.join(DATA_DIR, 'lab.json');
const COLLECTIONS = ['automations', 'leads', 'events', 'clients', 'invoices', 'calls', 'appointments', 'leadThreads', 'contents'];

let data = { automations: [], leads: [], events: [], clients: [], invoices: [], calls: [], appointments: [], leadThreads: [], contents: [] };
if (fs.existsSync(DB_FILE)) {
  try { data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { /* fresh start */ }
}
for (const k of ['automations', 'leads', 'events', 'clients', 'invoices', 'calls', 'appointments', 'leadThreads', 'contents']) {
  if (!Array.isArray(data[k])) data[k] = [];
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, DB_FILE);
  // keep the cloud copy fresh (debounced; no-op in local-only mode)
  cloud.schedulePush(JSON.stringify(data));
}
const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const now = () => new Date().toISOString();

// ── Automations catalog ───────────────────────────────────────────────
function listAutomations() {
  return data.automations.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
}
function getAutomation(slug) {
  return data.automations.find((a) => a.slug === slug) || null;
}
function upsertAutomation(a) {
  const i = data.automations.findIndex((x) => x.slug === a.slug);
  if (i >= 0) data.automations[i] = { ...data.automations[i], ...a };
  else data.automations.push(a);
  save();
  return a;
}

// ── Leads (deal requests from businesses) ────────────────────────────
function createLead({ name, email, company, industry, automationSlugs, message, monthlyBudget, timeline }) {
  const lead = {
    id: uid('lead'),
    name: String(name || '').trim(),
    email: String(email || '').trim(),
    company: String(company || '').trim(),
    industry: String(industry || '').trim(),
    automationSlugs: Array.isArray(automationSlugs) ? automationSlugs : [],
    message: String(message || '').trim().slice(0, 4000),
    monthlyBudget: String(monthlyBudget || '').trim(),
    timeline: String(timeline || '').trim(),
    status: 'new', // new | contacted | demo_booked | won | lost
    notes: '',
    testDrives: 0,
    createdAt: now(),
  };
  data.leads.push(lead);
  save();
  return lead;
}
function listLeads() {
  return data.leads.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function updateLead(id, patch) {
  const l = data.leads.find((x) => x.id === id);
  if (!l) return null;
  const allowed = ['status', 'notes'];
  for (const k of allowed) if (k in patch) l[k] = patch[k];
  save();
  return l;
}

// ── Clients (converted deals) ────────────────────────────────────────
// A client subscribes to one or more workers (automation slugs) with a
// billing cycle. monthlyTotal is computed from the catalog (quarterly -10%).
function clientMonthly(a, slug) {
  const cat = getAutomation(slug);
  if (!cat) return 0;
  return a === 'quarterly' ? Math.round(cat.price * 0.9) : cat.price;
}
function createClient({ name, email, company, slugs, cycle, notes, leadId }) {
  const list = Array.isArray(slugs) ? slugs.filter((s) => getAutomation(s)) : [];
  if (!list.length) return null;
  const client = {
    id: uid('cli'),
    name: String(name || '').trim(),
    email: String(email || '').trim(),
    company: String(company || '').trim(),
    slugs: list,
    cycle: cycle === 'quarterly' ? 'quarterly' : 'monthly',
    status: 'active', // active | paused | cancelled
    notes: String(notes || '').trim(),
    leadId: leadId || null,
    startedAt: now(),
  };
  data.clients.push(client);
  save();
  return client;
}
const listClients = () => data.clients.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
function updateClient(id, patch) {
  const c = data.clients.find((x) => x.id === id);
  if (!c) return null;
  const allowed = ['status', 'notes', 'slugs', 'cycle'];
  for (const k of allowed) if (k in patch) c[k] = patch[k];
  save();
  return c;
}

// ── Invoices ─────────────────────────────────────────────────────────
function generateInvoice(client) {
  const lines = client.slugs.map((s) => {
    const cat = getAutomation(s);
    const unit = clientMonthly(client.cycle, s);
    return { slug: s, name: cat ? cat.name : s, qty: 1, unit, total: unit };
  });
  const total = lines.reduce((sum, l) => sum + l.total, 0);
  const period = client.cycle === 'quarterly' ? 3 : 1;
  const invoice = {
    id: uid('inv'),
    clientId: client.id,
    clientName: client.name,
    company: client.company,
    lines,
    total,
    cycle: client.cycle,
    periodMonths: period,
    status: 'due', // due | paid
    dueAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    periodStart: now(),
    periodEnd: new Date(Date.now() + period * 30 * 86400000).toISOString(),
    paidAt: null,
    createdAt: now(),
  };
  data.invoices.push(invoice);
  save();
  return invoice;
}
function listInvoices(clientId) {
  return data.invoices
    .filter((i) => !clientId || i.clientId === clientId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function markInvoicePaid(id) {
  const inv = data.invoices.find((x) => x.id === id);
  if (!inv) return null;
  inv.status = 'paid';
  inv.paidAt = now();
  save();
  return inv;
}

// ── Voice agent: calls & booked appointments ─────────────────────────
function saveCall(session) {
  let c = data.calls.find((x) => x.id === session.id);
  const rec = {
    id: session.id,
    intent: session.intent || null,
    state: session.state,
    slots: session.slots,
    transcript: session.transcript,
    meta: session.meta || {},
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    done: !!session.done,
  };
  if (c) Object.assign(c, rec);
  else data.calls.push(rec);
  save();
  return rec;
}
const listCalls = () => data.calls.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));

function createAppointment({ callId, service, when, name, phone, company }) {
  const appt = { id: uid('apt'), callId: callId || null, service, when, name, phone, company: company || 'Demo Business', status: 'booked', createdAt: now() };
  data.appointments.push(appt);
  save();
  return appt;
}
const listAppointments = () => data.appointments.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// ── First Response: lead qualification threads ───────────────────────
function upsertLeadRecord(lead) {
  const i = data.leadThreads.findIndex((x) => x.id === lead.id);
  if (i >= 0) data.leadThreads[i] = lead;
  else data.leadThreads.push(lead);
  save();
  return lead;
}
function getLeadRecord(id) {
  return data.leadThreads.find((x) => x.id === id) || null;
}
const listLeadRecords = () => data.leadThreads.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// ── Content Crew: generated post sets ────────────────────────────────
function saveContent(gen) {
  data.contents.unshift(gen);
  if (data.contents.length > 200) data.contents = data.contents.slice(0, 200);
  save();
  return gen;
}
const listContents = () => data.contents.slice();

// ── Events (test-drive analytics) ─────────────────────────────────────
function addEvent(type, meta) {
  data.events.push({ id: uid('evt'), type, meta: meta || {}, createdAt: now() });
  // keep the file lean
  if (data.events.length > 5000) data.events = data.events.slice(-3000);
  save();
}
function listEvents(limit = 200) {
  return data.events.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
// ── health introspection (Telegram monitor / admin) ─────────────────
function dataFileHealth() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const j = JSON.parse(raw);
    const count = COLLECTIONS.reduce((n, k) => n + (Array.isArray(j[k]) ? j[k].length : 0), 0);
    return { ok: true, count, file: DB_FILE };
  } catch (e) {
    return { ok: false, count: 0, file: fs.existsSync(DB_FILE) ? DB_FILE : null, error: String(e.message || e) };
  }
}

function stats() {
  const by = (t) => data.events.filter((e) => e.type === t).length;
  const totalLeads = data.leads.length;
  const openLeads = data.leads.filter((l) => ['new', 'contacted', 'demo_booked'].includes(l.status)).length;
  // MRR: active clients, normalized to monthly (quarterly gets -10% baked in already)
  const mrr = data.clients
    .filter((c) => c.status === 'active')
    .reduce((sum, c) => sum + c.slugs.reduce((s, slug) => s + clientMonthly(c.cycle, slug), 0), 0);
  const dueTotal = data.invoices.filter((i) => i.status === 'due').reduce((s, i) => s + i.total, 0);
  const collected = data.invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + i.total, 0);
  return {
    testDrivesStarted: by('testdrive_started'),
    stepsCompleted: by('testdrive_step'),
    dealsRequested: totalLeads,
    openDeals: openLeads,
    wonDeals: data.leads.filter((l) => l.status === 'won').length,
    activeClients: data.clients.filter((c) => c.status === 'active').length,
    mrr,
    dueTotal,
    collected,
  };
}

module.exports = { save, uid, now, listAutomations, getAutomation, upsertAutomation, createLead, listLeads, updateLead, addEvent, listEvents, stats,
  createClient, listClients, updateClient, generateInvoice, listInvoices, markInvoicePaid, clientMonthly,
  saveCall, listCalls, createAppointment, listAppointments,
  upsertLeadRecord, getLeadRecord, listLeadRecords, saveContent, listContents, dataFileHealth,
  cloudStatus: cloud.status, cloudPushNow: () => cloud.pushNow(JSON.stringify(data)),
  // restore from cloud; if the file was replaced, reload it into memory so the
  // running server never pushes stale data back over the cloud copy
  cloudRestore: async () => {
    const r = await cloud.restoreIfNewer();
    if (r.restored) {
      try { data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) { data = {}; }
      for (const k of COLLECTIONS) if (!Array.isArray(data[k])) data[k] = [];
    }
    return r;
  } };
