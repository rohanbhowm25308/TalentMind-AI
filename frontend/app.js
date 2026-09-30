// ================= CONFIG =================
// When Flask serves this page (any host on port 5000, or a deployed site) use same-origin "/api".
// Only when the page is opened some other way (file://, or a separate dev server) point at Flask directly.
const SERVED_BY_FLASK = window.location.protocol.startsWith("http") &&
  (window.location.port === "5000" || !["localhost","127.0.0.1"].includes(window.location.hostname));
const API_BASE = SERVED_BY_FLASK ? "/api" : "http://127.0.0.1:5000/api";
const OFFLINE_MSG = "I can't reach the TalentMind backend right now. Make sure `python app.py` is still running in the backend folder, then try again.";

// ---- connection status pills ----
function setPill(id, state, text){
  const el = document.getElementById(id);
  if(!el) return;
  el.className = `conn-pill ${state}`;
  el.textContent = "● " + text;
}
let BACKEND_UP = null;
function setConnection(up, detail){
  const changed = BACKEND_UP !== up;
  BACKEND_UP = up;
  if(up) setPill("conn-backend", "ok", "Backend connected");
  else{
    setPill("conn-backend", "bad", "Backend unreachable" + (detail ? ` (${detail})` : ""));
    setPill("conn-ai", "bad", "AI unavailable");
  }
  if(up && changed && typeof DATASET !== "undefined" && DATASET === null && typeof fetchDataset === "function") fetchDataset();
}

// Wrap fetch for our own API: adds a timeout, turns HTML error pages into readable JSON errors,
// and keeps the connection pill honest.
const __nativeFetch = window.fetch.bind(window);
window.fetch = async function(url, opts = {}){
  if(typeof url !== "string" || !url.startsWith(API_BASE)) return __nativeFetch(url, opts);
  const ctrl = new AbortController();
  const timer = setTimeout(()=> ctrl.abort(), 45000);
  try{
    const res = await __nativeFetch(url, { ...opts, signal: ctrl.signal });
    setConnection(true);
    const ct = res.headers.get("content-type") || "";
    if(!ct.includes("application/json")){
      const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
      return new Response(JSON.stringify({ error: `Server replied ${res.status} ${res.statusText}. ${text}` }),
        { status: res.status >= 400 ? res.status : 502, headers: { "Content-Type": "application/json" } });
    }
    return res;
  }catch(err){
    const why = err.name === "AbortError" ? "timed out" : "connection refused";
    setConnection(false, why);
    const e = new Error(err.name === "AbortError" ? "The request timed out." : "Cannot connect to the backend.");
    e.isNetwork = true;
    throw e;
  }finally{
    clearTimeout(timer);
  }
};

async function checkHealth(deep){
  try{
    const res = await fetch(`${API_BASE}/health${deep ? "?check=1" : ""}`);
    const h = await res.json();
    if(!h.ai) return;
    if(h.ai.state === "ok") setPill("conn-ai", "ok", `AI connected (Groq · ${h.model})`);
    else if(h.ai.state === "unchecked") setPill("conn-ai", "warn", "AI key found — click Re-test");
    else{
      setPill("conn-ai", "bad", h.ai.state === "missing" ? "AI key missing" : "AI not responding");
      const d = document.getElementById("conn-detail");
      if(d) d.textContent = h.ai.detail || "";
      return;
    }
    const d = document.getElementById("conn-detail"); if(d) d.textContent = "";
  }catch(e){ /* pill already shows the network problem */ }
}
setInterval(()=> checkHealth(false), 10000);

// ================= DATASET STATE =================
let DATASET = null; // populated from /api/dataset

async function fetchDataset(){
  try{
    const res = await fetch(`${API_BASE}/dataset`);
    if(!res.ok) throw new Error("bad status");
    DATASET = await res.json();
  }catch(err){
    DATASET = null; // no backend reachable — UI shows a clear message instead of fake numbers
  }
  renderDataset();
}

function renderDataset(){
  const statusText = document.getElementById("dataset-status-text");
  if(!DATASET){
    statusText.innerHTML = `<span style="color:var(--red)">Could not reach the backend — start <code>python app.py</code> to load workforce data.</span>`;
    return;
  }

  const empty = DATASET.total_employees === 0;
  if(empty){
    statusText.innerHTML = `No workforce data yet. Add an employee below, upload a file, or load the example demo data.`;
  }else{
    statusText.innerHTML = `Currently showing: <strong>${DATASET.source}</strong> — ${DATASET.total_employees} employee${DATASET.total_employees===1?"":"s"}`;
  }

  // KPIs
  document.getElementById("kpi-total-employees").textContent = empty ? "—" : DATASET.total_employees.toLocaleString();
  document.getElementById("kpi-attrition-risk").textContent = empty ? "—" : DATASET.attrition_risk + "%";
  document.getElementById("kpi-open-positions").textContent = empty ? "—" : DATASET.open_positions;
  document.getElementById("kpi-skill-gaps").textContent = empty ? "—" : DATASET.skill_gaps;
  document.getElementById("kpi-workforce-health").innerHTML = empty ? "—" : DATASET.workforce_health + '<span class="kpi-of">/100</span>';
  document.getElementById("kpi-skill-coverage").textContent = empty ? "—" : DATASET.skill_coverage + "%";

  // Hero stat counters
  const heroMap = {
    "hero-stat-employees": DATASET.total_employees,
    "hero-stat-health": DATASET.workforce_health,
    "hero-stat-gaps": DATASET.skill_gaps,
  };
  Object.entries(heroMap).forEach(([id, val])=>{
    const el = document.getElementById(id);
    el.dataset.target = val;
    el.textContent = "0";
  });
  countUp();

  const deptNames = Object.keys(DATASET.departments);

  // Department dropdown (attrition explainer)
  const deptSelect = document.getElementById("attrition-dept-select");
  if(deptNames.length){
    deptSelect.innerHTML = deptNames.map(d=>`<option value="${d}">${d}</option>`).join("");
    deptSelect.disabled = false;
    loadAttrition(deptNames[0]);
  }else{
    deptSelect.innerHTML = `<option>No departments yet</option>`;
    deptSelect.disabled = true;
    document.getElementById("attrition-risk-badge").textContent = "No data";
    document.getElementById("attrition-risk-badge").className = "risk-badge";
    document.getElementById("attrition-risk-score").textContent = "—";
    document.getElementById("explain-question").textContent = "Add workforce data to see attrition risk explained here.";
    document.getElementById("explain-answer").textContent = "";
    document.getElementById("factor-bars").innerHTML = "";
  }

  // Risk radar, sorted highest risk first
  const radar = document.getElementById("radar-list");
  if(deptNames.length){
    const sorted = [...deptNames].sort((a,b)=> DATASET.departments[b].risk - DATASET.departments[a].risk);
    radar.innerHTML = sorted.map(d=>{
      const info = DATASET.departments[d];
      const cls = info.level === "high" ? "red" : info.level === "medium" ? "amber" : "green";
      const label = info.level.charAt(0).toUpperCase()+info.level.slice(1);
      return `<div class="radar-row" data-dept="${d}"><span class="dot ${cls}"></span>${d}<span class="radar-tag ${cls}">${label}</span></div>`;
    }).join("");
    document.querySelectorAll(".radar-row").forEach(row=>{
      row.addEventListener("click", ()=>{
        const dept = row.dataset.dept;
        document.getElementById("attrition-dept-select").value = dept;
        loadAttrition(dept);
        document.querySelector(".explain-card").scrollIntoView({behavior:"smooth", block:"center"});
      });
    });

    const top3 = sorted.slice(0,3);
    const actionTexts = [
      d => `Review ${d} workload distribution`,
      d => `Schedule career-growth discussions in ${d}`,
      d => `Identify skill-development opportunities in ${d}`
    ];
    top3.forEach((d,i)=>{
      const el = document.getElementById(`action-item-${i+1}`);
      if(el) el.innerHTML = `<span class="pri ${['red','amber','yellow'][i]}">P${i+1}</span> ${actionTexts[i](d)}`;
    });
    for(let i=top3.length; i<3; i++){
      const el = document.getElementById(`action-item-${i+1}`);
      if(el) el.innerHTML = `<span class="pri ${['red','amber','yellow'][i]}">P${i+1}</span> —`;
    }
  }else{
    radar.innerHTML = `<p class="empty-note">No departments yet — add employees to see the risk radar.</p>`;
    [1,2,3].forEach(i=>{
      const el = document.getElementById(`action-item-${i}`);
      if(el) el.innerHTML = `<span class="pri ${['red','amber','yellow'][i-1]}">P${i}</span> —`;
    });
  }

  // Skill graph employee dropdown
  const empSelect = document.getElementById("graph-employee-select");
  if(DATASET.employees.length){
    empSelect.innerHTML = DATASET.employees.map((e,i)=>`<option value="${i}">${e.name} — ${e.role}</option>`).join("");
    empSelect.disabled = false;
    renderGraphPath(0);
  }else{
    empSelect.innerHTML = `<option>No employees yet</option>`;
    empSelect.disabled = true;
    document.getElementById("graph-path-list").innerHTML = `<p class="empty-note">Add an employee to see their skill graph.</p>`;
  }
  window.__skillGraphRedraw && window.__skillGraphRedraw();

  // Skill DNA employee dropdown
  const dnaSelect = document.getElementById("dna-employee-select");
  if(DATASET.employees.length){
    dnaSelect.innerHTML = DATASET.employees.map((e,i)=>`<option value="${i}">${escapeHtml(e.name)} — ${escapeHtml(e.role)}</option>`).join("");
    dnaSelect.disabled = false;
    loadSkillDNA(0);
  }else{
    dnaSelect.innerHTML = `<option>No employees yet</option>`;
    dnaSelect.disabled = true;
    loadSkillDNA(0);
  }
}

function renderGraphPath(index){
  if(!DATASET || !DATASET.employees.length) return;
  const emp = DATASET.employees[index] || DATASET.employees[0];
  const pathEl = document.getElementById("graph-path-list");
  const doneHtml = (emp.skills.length ? emp.skills : ["No skills listed"]).map(s=>`<div class="graph-path-item done">${s}</div>`).join("");
  const targetHtml = (emp.missing_critical.length ? emp.missing_critical : ["Fully covered"]).map(s=>`<div class="graph-path-item target">${s}</div>`).join("");
  pathEl.innerHTML = doneHtml + `<div class="graph-arrow"><i class="fa-solid fa-arrow-right-long"></i></div>` + targetHtml;
}
document.getElementById("graph-employee-select").addEventListener("change", (e)=>{
  const idx = parseInt(e.target.value, 10);
  renderGraphPath(idx);
  window.__skillGraphSetActive && window.__skillGraphSetActive(idx);
});

// ================= DATA ENTRY TABS =================
document.querySelectorAll(".data-tab").forEach(tab=>{
  tab.addEventListener("click", ()=>{
    document.querySelectorAll(".data-tab").forEach(t=> t.classList.remove("active"));
    document.querySelectorAll(".data-tab-panel").forEach(p=> p.classList.add("hidden"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.remove("hidden");
  });
});

// ================= ADD EMPLOYEE (manual step-by-step) =================
document.getElementById("add-employee-btn").onclick = async ()=>{
  const errEl = document.getElementById("manual-error");
  errEl.textContent = "";
  const name = document.getElementById("mf-name").value.trim();
  const department = document.getElementById("mf-department").value.trim();
  if(!name || !department){
    errEl.textContent = "Name and Department are required.";
    return;
  }
  const payload = {
    name, department,
    role: document.getElementById("mf-role").value.trim(),
    skills: document.getElementById("mf-skills").value.trim(),
    engagement: document.getElementById("mf-engagement").value,
    overtime: document.getElementById("mf-overtime").value,
    growth: document.getElementById("mf-growth").value,
    managerSupport: document.getElementById("mf-manager").value,
    tenure: document.getElementById("mf-tenure").value,
    openPositions: document.getElementById("mf-openpositions").value,
  };
  const btn = document.getElementById("add-employee-btn");
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Adding...';
  try{
    const res = await fetch(`${API_BASE}/employees/add`, {
      method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(!res.ok){ errEl.textContent = data.error || "Could not add employee."; }
    else{
      DATASET = data;
      renderDataset();
      toast(`Added ${name} to ${department}`);
      ["mf-name","mf-department","mf-role","mf-skills","mf-engagement","mf-overtime","mf-growth","mf-manager","mf-tenure","mf-openpositions"]
        .forEach(id=> document.getElementById(id).value = "");
    }
  }catch(err){
    errEl.textContent = "Could not add employee: " + err.message;
  }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-plus"></i> Add Employee';
};

// ================= FILE UPLOAD =================
document.getElementById("dataset-file-input").addEventListener("change", async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const errEl = document.getElementById("upload-error");
  errEl.textContent = "";
  document.getElementById("dataset-status-text").innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Analyzing ${file.name}...`;

  const formData = new FormData();
  formData.append("file", file);
  try{
    const res = await fetch(`${API_BASE}/upload`, { method:"POST", body: formData });
    const data = await res.json();
    if(!res.ok){
      errEl.textContent = data.error || "Upload failed.";
      renderDataset();
      return;
    }
    DATASET = data;
    renderDataset();
    toast(`Loaded ${data.total_employees} employees from ${file.name}`);
  }catch(err){
    errEl.textContent = "Could not upload: " + err.message;
    renderDataset();
  }
  e.target.value = "";
});

document.getElementById("load-demo-btn").onclick = async ()=>{
  try{
    const res = await fetch(`${API_BASE}/demo`, { method:"POST" });
    DATASET = await res.json();
    renderDataset();
    toast("Loaded example demo data");
  }catch(err){
    toast("Could not load demo data: " + err.message);
  }
};

document.getElementById("clear-dataset-btn").onclick = async ()=>{
  try{
    const res = await fetch(`${API_BASE}/clear`, { method:"POST" });
    DATASET = await res.json();
    renderDataset();
    toast("Cleared all workforce data");
  }catch(err){
    toast("Could not clear data: " + err.message);
  }
};

document.getElementById("download-template-btn").onclick = ()=>{
  const csv = "Name,Department,Role,Skills,Engagement,Overtime,Growth,ManagerSupport,Performance,Tenure,OpenPositions\n"
    + "Jordan Blake,Engineering,Backend Developer,Python;SQL;AWS,68,82,55,60,74,24,12\n"
    + "Casey Morgan,Sales,Account Executive,Salesforce;SQL,74,58,62,71,80,14,6\n"
    + "Riley Chen,Marketing,Growth Marketer,SEO;Power BI,85,40,70,80,77,9,3\n";
  const blob = new Blob([csv], {type:"text/csv"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "talentmind_workforce_template.csv";
  a.click();
  URL.revokeObjectURL(url);
};

// ================= TOAST =================
function toast(msg){
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=> el.classList.remove("show"), 2600);
}

// ================= API HELPER (with local fallback) =================
async function callAPI(endpoint, payload, fallbackFn){
  try{
    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if(!res.ok) return { error: data.error || `Request failed (${res.status})`, ...data };
    return data;
  }catch(err){
    // Genuine network failure: use the local helper if one exists (never fabricate workforce numbers)
    return fallbackFn ? fallbackFn(payload) : { error: err.message };
  }
}

// ================= BACKGROUND =================
// Handled by backgrounds.js (10 selectable animated styles + picker UI).

// ================= SKILL GRAPH CANVAS =================
(function skillGraph(){
  const canvas = document.getElementById("skill-graph-canvas");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  let activeIndex = 0;

  function resize(){
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    draw();
  }

  function currentEmployee(){
    if(!DATASET || !DATASET.employees || !DATASET.employees.length) return null;
    return DATASET.employees[activeIndex] || DATASET.employees[0];
  }

  function draw(){
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    const emp = currentEmployee();
    if(!emp){
      ctx.fillStyle = "#6b7690"; ctx.font = "13px Inter"; ctx.textAlign = "center";
      ctx.fillText("Upload workforce data to see the skill graph", w/2, h/2);
      return;
    }
    const cx = w/2, cy = h/2;
    const t = performance.now()/1000;
    const current = emp.skills.length ? emp.skills : ["No listed skills"];
    const future = emp.missing_critical.length ? emp.missing_critical : ["Fully covered"];

    const curPositions = current.map((label, i) => {
      const angle = current.length>1 ? -0.9 + i * (1.8/(current.length-1)) : 0;
      return { label, x: cx - 190, y: cy + angle*110, color: "#3ce0ff" };
    });
    const futPositions = future.map((label, i) => {
      const angle = future.length>1 ? -0.9 + i * (1.8/(future.length-1)) : 0;
      return { label, x: cx + 190, y: cy + angle*110, color: "#a78bfa" };
    });

    ctx.lineWidth = 1;
    curPositions.forEach(p=>{
      ctx.strokeStyle = "rgba(60,224,255,0.35)";
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(cx, cy); ctx.stroke();
    });
    futPositions.forEach(p=>{
      ctx.strokeStyle = "rgba(167,139,250,0.35)";
      ctx.setLineDash([4,4]);
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.setLineDash([]);
    });

    // Flowing particles: current skills travel INTO the person (already have
    // this skill); target skills travel OUT from the person (growth path).
    function drawFlowParticle(x1, y1, x2, y2, color, phase, speed){
      const travel = ((t * speed) + phase) % 1;
      const px = x1 + (x2 - x1) * travel;
      const py = y1 + (y2 - y1) * travel;
      const fade = Math.sin(travel * Math.PI); // fades in/out at line ends
      ctx.beginPath();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.35 + fade * 0.65;
      ctx.shadowColor = color; ctx.shadowBlur = 8;
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
    curPositions.forEach((p, i)=>{
      drawFlowParticle(p.x, p.y, cx, cy, "#3ce0ff", i * 0.33, 0.35);
      drawFlowParticle(p.x, p.y, cx, cy, "#3ce0ff", i * 0.33 + 0.5, 0.35);
    });
    futPositions.forEach((p, i)=>{
      drawFlowParticle(cx, cy, p.x, p.y, "#a78bfa", i * 0.33, 0.3);
      drawFlowParticle(cx, cy, p.x, p.y, "#a78bfa", i * 0.33 + 0.5, 0.3);
    });

    const pulse = 26 + Math.sin(t*2)*3;
    const grad = ctx.createRadialGradient(cx,cy,0,cx,cy,pulse);
    grad.addColorStop(0, "rgba(79,140,255,0.9)");
    grad.addColorStop(1, "rgba(79,140,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx,cy,pulse,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = "#0b1324";
    ctx.beginPath(); ctx.arc(cx,cy,16,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle = "#4f8cff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx,cy,16,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle = "#eef3fb"; ctx.font = "600 11px Inter"; ctx.textAlign = "center";
    ctx.fillText((emp.name||"").split(" ")[0] || "—", cx, cy+4);

    function drawNode(p){
      ctx.beginPath();
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color; ctx.shadowBlur = 10;
      ctx.arc(p.x, p.y, 5, 0, Math.PI*2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#c7d3e8";
      ctx.font = "500 11px Inter";
      ctx.textAlign = p.x < cx ? "right" : "left";
      ctx.fillText(p.label, p.x + (p.x < cx ? -10 : 10), p.y+4);
    }
    curPositions.forEach(drawNode);
    futPositions.forEach(drawNode);
  }

  function loop(){ draw(); requestAnimationFrame(loop); }
  window.addEventListener("resize", resize);
  resize();
  loop();

  window.__skillGraphRedraw = ()=>{ activeIndex = 0; draw(); };
  window.__skillGraphSetActive = (idx)=>{ activeIndex = idx; draw(); };
})();

// ================= HERO STAT COUNTUP =================
function countUp(){
  document.querySelectorAll(".hnum").forEach(el=>{
    const target = parseInt(el.dataset.target, 10) || 0;
    let cur = 0;
    const step = Math.max(1, Math.ceil(target/40));
    clearInterval(el.__countTimer);
    el.__countTimer = setInterval(()=>{
      cur += step;
      if(cur >= target){ cur = target; clearInterval(el.__countTimer); }
      el.textContent = cur.toLocaleString();
    }, 25);
  });
}
countUp();

// ================= NAV / ASSISTANT DRAWER =================
const drawer = document.getElementById("assistant-drawer");
function openAssistant(){ drawer.classList.add("open"); }
document.getElementById("nav-assistant-btn").onclick = openAssistant;
document.getElementById("hero-ask-btn").onclick = openAssistant;
document.getElementById("cta-ask-btn").onclick = openAssistant;
document.getElementById("assistant-close").onclick = ()=> drawer.classList.remove("open");

async function assistantAsk(question){
  const body = document.getElementById("assistant-body");
  const userMsg = document.createElement("div");
  userMsg.className = "asst-msg user";
  userMsg.textContent = question;
  body.appendChild(userMsg);
  body.scrollTop = body.scrollHeight;

  const thinking = document.createElement("div");
  thinking.className = "asst-msg bot";
  thinking.textContent = "Routing to the right agent...";
  body.appendChild(thinking);
  body.scrollTop = body.scrollHeight;

  const data = await callAPI("ask", { question }, ()=>({ answer: OFFLINE_MSG, offline: true }));
  thinking.textContent = data.answer || data.error || OFFLINE_MSG;
  if(data.ai === false && data.ai_error){
    const note = document.createElement("div");
    note.className = "ai-note";
    note.textContent = "Answered by built-in rules — AI unavailable: " + data.ai_error;
    thinking.appendChild(note);
  }
  body.scrollTop = body.scrollHeight;
}
document.getElementById("assistant-send").onclick = ()=>{
  const input = document.getElementById("assistant-input");
  if(!input.value.trim()) return;
  assistantAsk(input.value.trim());
  input.value = "";
};
document.getElementById("assistant-input").addEventListener("keydown", e=>{
  if(e.key === "Enter") document.getElementById("assistant-send").click();
});

// ================= HERO SEARCH -> ASK PANEL =================
document.getElementById("hero-search-btn").onclick = ()=>{
  const q = document.getElementById("hero-search-input").value.trim();
  if(!q) return;
  document.getElementById("ask-input").value = q;
  document.getElementById("insights").scrollIntoView({behavior:"smooth"});
  setTimeout(()=> document.getElementById("ask-btn").click(), 400);
};

// ================= MOCK FALLBACKS (offline-safe demo intelligence) =================
function mockInsight(){
  const insights = [
    "Engineering shows the highest attrition risk this quarter. Primary signals: declining engagement, sustained overtime, and limited skill progression relative to role requirements.",
    "Workforce health improved 3 points this quarter, driven by stronger onboarding completion and reduced overtime in Sales and Marketing.",
    "23 critical skill gaps remain concentrated in Cloud, MLOps, and Power BI — concentrated in Engineering and Data teams."
  ];
  return { summary: insights[Math.floor(Math.random()*insights.length)] };
}

function mockMatch({ jd, resume }){
  const jdSkills = extractSkills(jd);
  const resumeSkills = extractSkills(resume);
  const matched = jdSkills.filter(s => resumeSkills.includes(s));
  const missing = jdSkills.filter(s => !resumeSkills.includes(s));
  const skillPct = Math.round((matched.length / Math.max(jdSkills.length,1)) * 100);
  const expPct = Math.min(96, 70 + Math.floor(Math.random()*20));
  const overall = Math.round(skillPct*0.65 + expPct*0.35);
  return {
    overall_score: overall,
    skill_match: skillPct,
    experience_match: expPct,
    required_total: jdSkills.length,
    required_met: matched.length,
    matched_skills: matched,
    missing_skills: missing
  };
}

const KNOWN_SKILLS = ["Python","AWS","React","SQL","Power BI","Cloud","Azure","Machine Learning","Docker","Kubernetes","Java","Spring Boot","REST APIs","System Design","GraphQL","Excel","Predictive Modeling","A/B Testing","MLOps","LLM Deployment","PostgreSQL","JavaScript","TypeScript","Node.js","Leadership","Communication"];
function extractSkills(text){
  if(!text) return [];
  const found = [];
  KNOWN_SKILLS.forEach(skill=>{
    const re = new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'), "i");
    if(re.test(text)) found.push(skill);
  });
  // also split comma lists for skill inputs
  text.split(/[,\n]/).forEach(part=>{
    const p = part.trim();
    if(p.length>1 && p.length<28 && !found.includes(p) && !/[.]{1}\s\w{10,}/.test(p) && p.split(" ").length<=3){
      // heuristic: short, comma-separated tokens look like discrete skills
    }
  });
  return found;
}

function mockGap({ current, target }){
  const cur = current.split(",").map(s=>s.trim()).filter(Boolean);
  const tgt = target.split(",").map(s=>s.trim()).filter(Boolean);
  const matched = tgt.filter(s => cur.some(c=>c.toLowerCase()===s.toLowerCase()));
  const missing = tgt.filter(s => !cur.some(c=>c.toLowerCase()===s.toLowerCase()));
  const plan = missing.map((skill, i)=>({ month:`Month ${i+1}`, skill: `${skill} Fundamentals`}));
  return { matched, missing, plan };
}

function mockExplain({ dept }){
  const table = {
    Engineering: { risk:73, level:"high", answer:"Attrition risk increased due to declining engagement, higher overtime, limited skill progression, and reduced manager interaction.", factors:{Engagement:72,Overtime:88,Growth:54,"Manager Support":61} },
    Sales: { risk:52, level:"medium", answer:"Attrition risk is moderate, driven mainly by quota pressure and inconsistent commission payouts, offset by strong team engagement.", factors:{Engagement:66,Overtime:58,Growth:60,"Manager Support":70} },
    Marketing: { risk:28, level:"low", answer:"Attrition risk is low. Engagement and manager support remain strong, with only minor overtime spikes around campaign launches.", factors:{Engagement:81,Overtime:40,Growth:70,"Manager Support":78} },
    Finance: { risk:47, level:"medium", answer:"Attrition risk is moderate, linked to limited growth opportunities and workload concentration during close periods.", factors:{Engagement:70,Overtime:55,Growth:48,"Manager Support":66} },
    HR: { risk:22, level:"low", answer:"Attrition risk is low, supported by strong engagement and healthy manager relationships across the team.", factors:{Engagement:84,Overtime:35,Growth:66,"Manager Support":82} }
  };
  return table[dept] || table.Engineering;
}

function mockAsk({ question }){
  const q = (question||"").toLowerCase();
  if(q.includes("attrition") && q.includes("department")){
    return { answer: "Engineering has the highest attrition risk at 73/100, followed by Sales at 52/100. Evidence: elevated overtime (88%) and below-average manager interaction (61%) in Engineering. Recommended action: prioritize a retention review for the 6 flagged Engineering employees this month." };
  }
  if(q.includes("skill")){
    return { answer: "The most common missing skills across teams are Cloud (Azure), Power BI, and MLOps — 23 critical gaps in total, concentrated in Engineering and Data roles. Recommended action: launch a 90-day upskilling cohort for Cloud and Power BI." };
  }
  if(q.includes("action") || q.includes("quarter")){
    return { answer: "Top recommended actions this quarter: (1) Review Engineering workload distribution, (2) Run career-growth conversations for high-risk employees, (3) Launch a Cloud/Power BI upskilling track, (4) Increase manager check-in frequency in Engineering and Finance." };
  }
  return { answer: "Based on current workforce data: workforce health is 87/100, attrition risk sits at 14.8% company-wide, and 23 critical skill gaps remain open — most concentrated in Engineering. Ask about a specific department or skill for a deeper, evidence-backed answer." };
}

function mockPolicy({ doc, question }){
  const q = question.toLowerCase();
  const sentences = doc.split(/\.(?=\s|$)/).map(s=>s.trim()).filter(Boolean);
  let best = sentences[0] || "";
  let bestScore = -1;
  const qWords = q.split(/\W+/).filter(w=>w.length>3);
  sentences.forEach(s=>{
    const sl = s.toLowerCase();
    const score = qWords.reduce((acc,w)=> acc + (sl.includes(w)?1:0), 0);
    if(score > bestScore){ bestScore = score; best = s; }
  });
  return { answer: best + ".", source: "Pasted Policy Document" };
}

function mockWhatif({ hire, train }){
  const baseAttrition = 14.8, baseSkill = 76, baseHiring = 86;
  const attrition = Math.max(3, (baseAttrition - train*0.06 + hire*0.05)).toFixed(1);
  const skill = Math.min(98, Math.round(baseSkill + train*0.35 - Math.abs(hire)*0.05));
  const hiring = Math.round(baseHiring + hire*1.4);
  const cost = Math.round(hire*0.9 + train*0.4);
  const riskLevel = attrition > 18 ? "High" : attrition > 12 ? "Medium" : "Low";
  return { attrition: `${attrition}%`, skill: `${skill}%`, hiring: `${hiring} roles`, cost: `${cost>=0?"+":""}${cost}%`, risk: riskLevel };
}

function mockReport(){
  return { report: "Workforce Overview: 1,248 employees, 87/100 health score, 14.8% attrition risk.\n\nTop Risks: Engineering attrition (73/100), driven by overtime and limited growth paths.\n\nSkill Gaps: 23 critical gaps, concentrated in Cloud, MLOps, and Power BI.\n\nAttrition Trend: Down 2.1pts vs last quarter, but Engineering trending upward.\n\nPerformance Insights: Overall performance up 11% over two quarters; skill development demand rising in parallel.\n\nRecommended Actions: (1) Engineering workload review, (2) Cloud/Power BI upskilling cohort, (3) manager check-in cadence increase, (4) targeted retention conversations for 6 flagged employees." };
}

// ================= WIRE UP: KPI REFRESH + SUMMARY =================
document.getElementById("refresh-kpis").onclick = ()=> toast("Workforce metrics refreshed");
document.getElementById("regen-summary-btn").onclick = async ()=>{
  const btn = document.getElementById("regen-summary-btn");
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Thinking...';
  const data = await callAPI("insight", {}, ()=>({ summary: OFFLINE_MSG }));
  document.getElementById("workforce-summary-text").textContent = data.summary || data.error || OFFLINE_MSG;
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Regenerate with AI';
};

// ================= RECRUITMENT MATCH =================
document.getElementById("match-btn").onclick = async ()=>{
  const btn = document.getElementById("match-btn");
  const jd = document.getElementById("jd-input").value;
  const resume = document.getElementById("resume-input").value;
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Matching...';

  const data = await callAPI("recruitment/match", { jd, resume }, mockMatch);
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Run AI Match';

  const score = data.overall_score ?? 0;
  document.getElementById("match-score-num").textContent = score + "%";
  document.getElementById("mm-skill").textContent = (data.skill_match ?? 0) + "%";
  document.getElementById("mm-exp").textContent = (data.experience_match ?? 0) + "%";
  document.getElementById("mm-req").textContent = `${data.required_met ?? 0}/${data.required_total ?? 0}`;

  const circumference = 327;
  const offset = circumference - (circumference * score/100);
  document.getElementById("match-ring").style.strokeDashoffset = offset;

  const whyList = document.getElementById("why-list");
  whyList.innerHTML = "";
  (data.matched_skills||[]).forEach(s=>{
    whyList.innerHTML += `<div class="why-item ok"><span>${s}</span><span>Required ✓</span></div>`;
  });
  (data.missing_skills||[]).forEach(s=>{
    whyList.innerHTML += `<div class="why-item missing"><span>${s}</span><span>Missing ⚠</span></div>`;
  });
  if(!whyList.innerHTML) whyList.innerHTML = '<p class="muted-hint">No structured skills detected — try listing skills explicitly.</p>';
};

// ================= SKILL GAP + GROWTH PLAN =================
document.getElementById("gap-btn").onclick = async ()=>{
  const current = document.getElementById("gap-current-skills").value;
  const target = document.getElementById("gap-target-skills").value;
  const data = await callAPI("skills/gap", { current, target }, mockGap);

  const tree = document.getElementById("skill-tree-list");
  tree.innerHTML = "";
  (data.matched||[]).forEach(s=> tree.innerHTML += `<div class="skill-node matched"><i class="fa-solid fa-check"></i> ${s}</div>`);
  (data.missing||[]).forEach(s=> tree.innerHTML += `<div class="skill-node missing"><i class="fa-solid fa-triangle-exclamation"></i> ${s}</div>`);

  const planEl = document.getElementById("growth-plan-list");
  planEl.innerHTML = "";
  (data.plan||[]).forEach(item=>{
    planEl.innerHTML += `<div class="growth-item"><span class="growth-month">${item.month}</span><span>${item.skill}</span></div>`;
  });
  toast("Skill gap analysis complete");
};

// ================= ATTRITION / EXPLAINABLE AI =================
async function loadAttrition(dept){
  const data = await callAPI("attrition/predict", { dept }, ()=>({ error: OFFLINE_MSG }));
  if(data.error){
    document.getElementById("explain-answer").textContent = data.error;
    return;
  }
  const badge = document.getElementById("attrition-risk-badge");
  badge.className = `risk-badge ${data.level}`;
  badge.textContent = data.level.charAt(0).toUpperCase()+data.level.slice(1)+" Risk";
  document.getElementById("attrition-risk-score").textContent = `${data.risk}/100`;
  document.getElementById("explain-question").textContent = `Why is ${dept} showing ${data.level} attrition risk?`;
  document.getElementById("explain-answer").textContent = data.answer;

  const bars = document.getElementById("factor-bars");
  bars.innerHTML = "";
  Object.entries(data.factors).forEach(([k,v])=>{
    bars.innerHTML += `<div class="factor-row"><span>${k}</span><div class="bar"><div class="bar-fill ${v>80?'warn':''}" style="width:${v}%"></div></div><em>${v}%</em></div>`;
  });
}
document.getElementById("attrition-dept-select").addEventListener("change", e=> loadAttrition(e.target.value));
document.getElementById("explain-btn").onclick = ()=>{
  if(!DATASET || !DATASET.total_employees){ toast("Add workforce data first"); return; }
  loadAttrition(document.getElementById("attrition-dept-select").value);
};
document.getElementById("action-plan-btn").onclick = ()=>{
  toast("Action plan generated — see AI Action Center");
  document.getElementById("action-center").scrollIntoView({behavior:"smooth", block:"center"});
};
document.querySelectorAll(".radar-row").forEach(row=>{
  row.addEventListener("click", ()=>{
    const dept = row.dataset.dept;
    document.getElementById("attrition-dept-select").value = dept;
    loadAttrition(dept);
    document.querySelector(".explain-card").scrollIntoView({behavior:"smooth", block:"center"});
  });
});

// ================= AI AGENT MISSION CONTROL =================
const sleep = ms => new Promise(r=>setTimeout(r, ms));
function setAgent(key, state, text){
  const node = document.querySelector(`.agent-node[data-agent="${key}"]`);
  if(!node) return;
  node.classList.remove("active","done");
  if(state) node.classList.add(state);
  node.querySelector("small").textContent = text;
}
function flowConnectors(on){
  document.querySelectorAll(".mc-connector").forEach(c=> c.classList.toggle("flow", on));
}
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

document.getElementById("run-orchestrator-btn").onclick = async ()=>{
  const question = document.getElementById("mission-question-input").value.trim();
  if(!question){ toast("Type a question for the agents to investigate"); return; }
  if(!DATASET || !DATASET.total_employees){ toast("Add workforce data first so agents have something to investigate"); return; }

  const btn = document.getElementById("run-orchestrator-btn");
  btn.disabled = true;
  document.getElementById("investigation-result").classList.add("hidden");
  ["attrition","skills","performance","recommendation"].forEach(k=> setAgent(k, null, "Idle"));
  const plan = document.getElementById("agent-action-plan");
  plan.classList.remove("active","done"); plan.querySelector("small").textContent = "Pending";

  const orch = document.getElementById("agent-orchestrator");
  const orchStatus = document.getElementById("orch-status");
  orch.classList.remove("done"); orch.classList.add("active"); orchStatus.textContent = "Routing question...";
  flowConnectors(true);

  // Fire the real investigation request while the animation plays
  const resultPromise = fetch(`${API_BASE}/investigate`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({question})
  }).then(r=> r.json().then(j=>({ok:r.ok, j}))).catch(()=>({ok:false, j:{error:"Could not reach the backend."}}));

  await sleep(600);
  const steps = [
    ["attrition", "Analyzing...", "Reasoning..."],
    ["performance", "Analyzing...", "Reasoning..."],
    ["skills", "Analyzing...", "Reasoning..."],
    ["recommendation", "Synthesizing...", "Reasoning..."],
  ];
  for(const [key, a1, a2] of steps){
    setAgent(key, "active", a1); await sleep(550);
    setAgent(key, "active", a2); await sleep(450);
    setAgent(key, "done", "Completed");
  }
  plan.classList.add("active"); plan.querySelector("small").textContent = "Building...";
  const {ok, j} = await resultPromise;
  await sleep(300);
  flowConnectors(false);
  orch.classList.remove("active"); orch.classList.add("done"); orchStatus.textContent = "Completed";

  if(!ok){
    plan.classList.remove("active"); plan.querySelector("small").textContent = "Failed";
    toast(j.error || "Investigation failed");
    btn.disabled = false;
    return;
  }
  plan.classList.remove("active"); plan.classList.add("done"); plan.querySelector("small").textContent = "Ready";

  document.getElementById("inv-dept").textContent = j.department;
  const badge = document.getElementById("inv-risk-badge");
  badge.className = `risk-badge ${j.risk_level}`;
  badge.textContent = `${j.risk_level.charAt(0).toUpperCase()+j.risk_level.slice(1)} Risk · ${j.risk_score}/100`;
  const fill = (id, arr)=> document.getElementById(id).innerHTML = (arr||[]).map(x=>`<li>${escapeHtml(x)}</li>`).join("");
  fill("inv-evidence", j.evidence); fill("inv-factors", j.factors); fill("inv-actions", j.actions);
  document.getElementById("investigation-result").classList.remove("hidden");
  document.getElementById("investigation-result").scrollIntoView({behavior:"smooth", block:"nearest"});
  btn.disabled = false;
};
document.getElementById("mission-question-input").addEventListener("keydown", e=>{
  if(e.key==="Enter") document.getElementById("run-orchestrator-btn").click();
});

// ================= ASK YOUR WORKFORCE DATA =================
async function askWorkforce(question){
  const chat = document.getElementById("ask-chat");
  chat.innerHTML += `<div class="ask-bubble user">${escapeHtml(question)}</div>`;
  const loadingBubble = document.createElement("div");
  loadingBubble.className = "ask-bubble ai";
  loadingBubble.innerHTML = `<span class="ask-label">TalentMind AI</span>Analyzing workforce data...`;
  chat.appendChild(loadingBubble);
  chat.scrollTop = chat.scrollHeight;

  const data = await callAPI("ask", { question }, ()=>({ answer: OFFLINE_MSG, offline: true }));
  const note = (data.ai === false && data.ai_error) ? `<div class="ai-note">Answered by built-in rules — AI unavailable: ${escapeHtml(data.ai_error)}</div>` : "";
  loadingBubble.innerHTML = `<span class="ask-label">TalentMind AI</span>${escapeHtml(data.answer || data.error || OFFLINE_MSG)}${note}`;
  chat.scrollTop = chat.scrollHeight;
}
document.getElementById("ask-btn").onclick = ()=>{
  const input = document.getElementById("ask-input");
  if(!input.value.trim()) return;
  askWorkforce(input.value.trim());
  input.value = "";
};
document.getElementById("ask-input").addEventListener("keydown", e=>{ if(e.key==="Enter") document.getElementById("ask-btn").click(); });
document.querySelectorAll(".chip").forEach(chip=>{
  chip.addEventListener("click", ()=> askWorkforce(chip.textContent));
});

// ================= HR POLICY ASSISTANT =================
document.getElementById("policy-ask-btn").onclick = async ()=>{
  const doc = document.getElementById("policy-doc-input").value;
  const question = document.getElementById("policy-question-input").value;
  const data = await callAPI("policy/ask", { doc, question }, mockPolicy);
  document.getElementById("policy-result-card").innerHTML = `
    <p class="why-title"><i class="fa-solid fa-robot"></i> Answer</p>
    <p class="explain-answer">${data.answer}</p>
    <p class="why-title"><i class="fa-solid fa-file-lines"></i> Source</p>
    <p class="muted-hint">📄 ${data.source}</p>
  `;
};

// ================= WORKFORCE DIGITAL TWIN =================
const sliderDefs = [
  ["hire-slider","hire-slider-val", v=>(v>=0?"+":"")+v+"%"],
  ["train-slider","train-slider-val", v=>(v>=0?"+":"")+v+"%"],
  ["remote-slider","remote-slider-val", v=>(v>=0?"+":"")+v+"%"],
  ["attrition-slider","attrition-slider-val", v=>"-"+v+"%"],
];
sliderDefs.forEach(([id,valId,fmt])=>{
  const el = document.getElementById(id);
  el.addEventListener("input", ()=> document.getElementById(valId).textContent = fmt(el.value));
});

const inr = n => "₹" + (n/10000000).toFixed(2) + " Cr";
document.getElementById("run-whatif-btn").onclick = async ()=>{
  if(!DATASET || !DATASET.total_employees){ toast("Add workforce data first so there's a baseline to simulate"); return; }
  const btn = document.getElementById("run-whatif-btn");
  btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Simulating...';
  const payload = {
    hire: +document.getElementById("hire-slider").value,
    train: +document.getElementById("train-slider").value,
    remote: +document.getElementById("remote-slider").value,
    attritionAdj: +document.getElementById("attrition-slider").value,
  };
  try{
    const res = await fetch(`${API_BASE}/whatif`, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
    const d = await res.json();
    if(!res.ok){ toast(d.error || "Simulation failed"); }
    else{
      const b = d.before, a = d.after;
      const rows = [
        ["attrition", b.attrition+"%", a.attrition+"%", b.attrition, a.attrition, true],
        ["skill", b.skill_coverage+"%", a.skill_coverage+"%", b.skill_coverage, a.skill_coverage, false],
        ["hiring", b.hiring_demand, a.hiring_demand, b.hiring_demand, a.hiring_demand, true],
        ["cost", inr(b.cost), inr(a.cost), b.cost, a.cost, true],
      ];
      rows.forEach(([id, bt, at, bn, an, lower])=>{
        document.getElementById(`twin-${id}-before`).textContent = bt;
        const el = document.getElementById(`twin-${id}-after`);
        const dir = an===bn ? "" : (an<bn ? " ↓" : " ↑");
        el.textContent = at + dir;
        el.classList.remove("better","worse");
        if(an!==bn){
          const improved = lower ? an<bn : an>bn;
          el.classList.add(improved ? "better" : "worse");
        }
      });
      document.getElementById("twin-risk-before").textContent = b.risk;
      const riskAfter = document.getElementById("twin-risk-after");
      riskAfter.textContent = a.risk;
      const rank = {Low:0, Medium:1, High:2};
      riskAfter.classList.remove("better","worse");
      if(rank[a.risk] < rank[b.risk]) riskAfter.classList.add("better");
      else if(rank[a.risk] > rank[b.risk]) riskAfter.classList.add("worse");
      const rec = document.getElementById("twin-recommendation-text");
      rec.classList.remove("muted-hint");
      rec.textContent = d.recommendation;
      toast("Digital Twin simulation complete");
    }
  }catch(err){
    toast("Simulation failed: " + err.message);
  }
  btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-flask"></i> Run Simulation';
};

// ================= EMPLOYEE SKILL DNA =================
async function loadSkillDNA(index){
  const panel = document.getElementById("dna-panel");
  if(!DATASET || !DATASET.employees.length){
    panel.innerHTML = `<p class="empty-note">Add or select an employee to generate their Skill DNA.</p>`;
    return;
  }
  panel.innerHTML = `<p class="empty-note"><i class="fa-solid fa-spinner fa-spin"></i> Sequencing skill DNA...</p>`;
  try{
    const res = await fetch(`${API_BASE}/skill-dna`, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({index})});
    const d = await res.json();
    if(!res.ok){ panel.innerHTML = `<p class="empty-note">${escapeHtml(d.error||"Could not build Skill DNA.")}</p>`; return; }
    const bars = d.proficiencies.length
      ? d.proficiencies.map(p=>`<div class="dna-row"><span>${escapeHtml(p.skill)}</span><div class="bar"><div class="bar-fill" style="width:${p.pct}%"></div></div><em>${p.pct}%</em></div>`).join("")
      : `<p class="muted-hint">No skills listed for this employee yet.</p>`;
    const strengths = d.strengths.map(s=>`<span class="dna-tag strength">${escapeHtml(s)}</span>`).join("");
    const gaps = d.gaps.length ? d.gaps.map(s=>`<span class="dna-tag gap">${escapeHtml(s)}</span>`).join("") : `<span class="muted-hint">No critical gaps detected</span>`;
    panel.innerHTML = `
      <div class="dna-grid">
        <div>
          <p class="dna-title">${escapeHtml(d.name)}'s Skill DNA</p>
          <p class="dna-sub">${escapeHtml(d.role)} · ${escapeHtml(d.department)}</p>
          <div class="dna-bars">${bars}</div>
        </div>
        <div class="dna-side">
          <div class="dna-readiness"><small>AI Readiness</small><strong>${d.ai_readiness}/100</strong></div>
          <div><p class="inv-label"><i class="fa-solid fa-star"></i> Your strengths</p><div class="dna-tags">${strengths}</div></div>
          <div><p class="inv-label"><i class="fa-solid fa-triangle-exclamation"></i> Skill gaps</p><div class="dna-tags">${gaps}</div></div>
          <div class="dna-next"><strong>Recommended next step</strong>${escapeHtml(d.recommended_next_step)}</div>
        </div>
      </div>`;
  }catch(err){
    panel.innerHTML = `<p class="empty-note">Could not build Skill DNA: ${escapeHtml(err.message)}</p>`;
  }
}
document.getElementById("dna-employee-select").addEventListener("change", e=> loadSkillDNA(parseInt(e.target.value,10)));

// ================= EXECUTIVE REPORT =================
document.getElementById("gen-report-btn").onclick = async (e)=>{
  e.preventDefault();
  toast("Generating executive report...");
  const data = await callAPI("report", {}, ()=>({ report: OFFLINE_MSG }));
  const win = window.open("", "_blank");
  win.document.write(`<html><head><title>TalentMind AI — Executive Report</title>
    <style>body{font-family:Inter,sans-serif;background:#050912;color:#eef3fb;padding:40px;white-space:pre-wrap;line-height:1.7;} h1{color:#3ce0ff;}</style>
    </head><body><h1>TalentMind AI — Executive Workforce Report</h1><p>${data.report.replace(/\n/g,"<br>")}</p></body></html>`);
  win.document.close();
};

// ================= VOICE INPUT (Web Speech API) =================
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
function attachVoice(micBtnId, inputId, onFinal){
  const mic = document.getElementById(micBtnId);
  const input = document.getElementById(inputId);
  if(!mic || !input) return;
  if(!SpeechRec){
    mic.title = "Voice input isn't supported in this browser (try Chrome or Edge)";
    mic.style.opacity = "0.45";
    mic.onclick = ()=> toast("Voice input isn't supported in this browser — try Chrome or Edge");
    return;
  }
  let rec = null, listening = false;
  mic.onclick = ()=>{
    if(listening){ rec && rec.stop(); return; }
    rec = new SpeechRec();
    rec.lang = "en-IN";
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = "";
    rec.onstart = ()=>{ listening = true; mic.classList.add("listening"); input.placeholder = "Listening..."; };
    rec.onresult = (ev)=>{
      let interim = "";
      for(let i = ev.resultIndex; i < ev.results.length; i++){
        const t = ev.results[i][0].transcript;
        if(ev.results[i].isFinal) finalText += t; else interim += t;
      }
      input.value = (finalText + interim).trim();
    };
    rec.onerror = (ev)=>{
      const msgs = {
        "not-allowed": "Microphone access was blocked — allow it in your browser's address bar.",
        "service-not-allowed": "Microphone access was blocked — allow it in your browser's address bar.",
        "no-speech": "I didn't hear anything — try again.",
        "audio-capture": "No microphone found.",
        "network": "Voice recognition needs an internet connection."
      };
      toast(msgs[ev.error] || `Voice input error: ${ev.error}`);
    };
    rec.onend = ()=>{
      listening = false; mic.classList.remove("listening");
      input.placeholder = input.dataset.origPlaceholder || input.placeholder;
      const text = input.value.trim();
      if(text && onFinal) onFinal(text);
    };
    input.dataset.origPlaceholder = input.dataset.origPlaceholder || input.placeholder;
    try{ rec.start(); }catch(e){ /* already started */ }
  };
}
attachVoice("assistant-mic", "assistant-input", ()=> document.getElementById("assistant-send").click());
attachVoice("ask-mic-btn", "ask-input", ()=> document.getElementById("ask-btn").click());

// ================= INITIAL LOAD =================
const retestBtn = document.getElementById("conn-retest");
if(retestBtn) retestBtn.onclick = async ()=>{
  setPill("conn-ai", "warn", "Testing AI...");
  await checkHealth(true);
  if(BACKEND_UP && DATASET === null) fetchDataset();
};
fetchDataset();
checkHealth(true);
