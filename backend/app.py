import os
import re
import io
import json
import random
import hashlib
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import requests
import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))  # explicit path: works no matter where you run python from

GROQ_API_KEY = (os.getenv("GROQ_API_KEY", "") or "").strip().strip('"').strip("'")
GROQ_MODEL = (os.getenv("GROQ_MODEL", "") or "auto").strip()   # "auto" = ask Groq what's available
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models"
MODEL_STATE = {"resolved": None}

# Best-first. Non-reasoning chat models first (fast, clean output); reasoning models after.
MODEL_PREFERENCE = [
    "llama-3.3-70b-versatile",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "moonshotai/kimi-k2-instruct-0905",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant",
    "qwen/qwen3-32b",
]
NOT_CHAT_MODELS = ("whisper", "tts", "guard", "safeguard", "embed", "orpheus", "distil-whisper")
REASONING_MARKERS = ("gpt-oss", "qwen3", "deepseek-r1", "qwq")
LAST_GROQ_ERROR = {"msg": None}


def groq_key_problem():
    """Return a human-readable problem with the configured key, or None if it looks fine."""
    if not GROQ_API_KEY or GROQ_API_KEY.startswith("your_"):
        return "No Groq API key set. Open backend/.env and put your key after GROQ_API_KEY="
    if GROQ_API_KEY.startswith("xai-"):
        return "That looks like an xAI 'Grok' key (xai-...). This app needs a GROQ key from console.groq.com (starts with gsk_)."
    if not GROQ_API_KEY.startswith("gsk_"):
        return "The key doesn't look like a Groq key (should start with gsk_). Get one at console.groq.com/keys."
    return None


# The frontend lives in a sibling folder: talentmind-ai/frontend
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app)


@app.route("/")
def serve_index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:filename>")
def serve_static_file(filename):
    return send_from_directory(FRONTEND_DIR, filename)


# ---------------------------------------------------------------------------
# Column format any uploaded CSV / XLSX must follow (see README + the
# in-app "Download sample template" button). Everything except Name and
# Department is optional and gets a sensible default if missing.
#
#   Name, Department, Role, Skills, Engagement, Overtime, Growth,
#   ManagerSupport, Performance, Tenure, OpenPositions
#
# Skills is a single cell, semicolon-separated, e.g. "Python;SQL;AWS"
# Engagement / Overtime / Growth / ManagerSupport / Performance are 0-100
# ---------------------------------------------------------------------------
CRITICAL_SKILLS = ["Python", "SQL", "Cloud", "Power BI", "Machine Learning",
                    "MLOps", "AWS", "Azure", "React", "Docker"]

REQUIRED_COLUMNS = ["Name", "Department"]
DEFAULTS = {"Engagement": 70, "Overtime": 50, "Growth": 60, "ManagerSupport": 65,
            "Performance": 70, "Tenure": 18, "OpenPositions": 0, "Role": "Employee", "Skills": ""}


def _generate_demo_dataframe():
    """One consistent, generic demo dataset (not hand-picked individuals) so
    the platform has something sensible to show before anyone uploads data."""
    random.seed(42)
    departments = {
        "Engineering": {"eng": (55, 75), "ot": (70, 95), "gr": (40, 65), "ms": (45, 70)},
        "Sales":       {"eng": (60, 80), "ot": (45, 70), "gr": (50, 70), "ms": (60, 80)},
        "Marketing":   {"eng": (75, 90), "ot": (30, 55), "gr": (60, 80), "ms": (70, 88)},
        "Finance":     {"eng": (62, 80), "ot": (45, 65), "gr": (40, 60), "ms": (58, 76)},
        "HR":          {"eng": (78, 92), "ot": (25, 45), "gr": (55, 75), "ms": (72, 90)},
    }
    role_by_dept = {
        "Engineering": ["Backend Developer", "Data Engineer", "Frontend Developer", "QA Engineer"],
        "Sales": ["Account Executive", "Sales Development Rep", "Sales Manager"],
        "Marketing": ["Content Strategist", "Growth Marketer", "Brand Manager"],
        "Finance": ["Financial Analyst", "Accountant", "FP&A Associate"],
        "HR": ["HR Business Partner", "Recruiter", "People Ops Analyst"],
    }
    skill_pool_by_dept = {
        "Engineering": ["Python", "SQL", "AWS", "React", "Docker", "Machine Learning", "System Design"],
        "Sales": ["Salesforce", "Negotiation", "SQL", "Power BI"],
        "Marketing": ["SEO", "Content Strategy", "Power BI", "A/B Testing"],
        "Finance": ["Excel", "SQL", "Power BI", "Forecasting"],
        "HR": ["Excel", "People Analytics", "Power BI", "Communication"],
    }
    first_names = ["Aarav", "Vivaan", "Ishaan", "Kabir", "Aryan", "Diya", "Ananya", "Saanvi",
                   "Myra", "Kiara", "Rohan", "Aditya", "Sara", "Priya", "Neha", "Tanvi",
                   "Arjun", "Dev", "Meera", "Riya", "Kunal", "Sanya", "Yash", "Zara"]
    last_names = ["Sharma", "Verma", "Iyer", "Nair", "Gupta", "Reddy", "Khan", "Patel",
                  "Chopra", "Mehta", "Rao", "Bose", "Kapoor", "Malhotra", "Singh"]

    rows = []
    emp_id = 0
    for dept, ranges in departments.items():
        n = {"Engineering": 11, "Sales": 8, "Marketing": 6, "Finance": 6, "HR": 5}[dept]
        for _ in range(n):
            emp_id += 1
            name = f"{random.choice(first_names)} {random.choice(last_names)}"
            skills = random.sample(skill_pool_by_dept[dept], k=min(3, len(skill_pool_by_dept[dept])))
            rows.append({
                "Name": name,
                "Department": dept,
                "Role": random.choice(role_by_dept[dept]),
                "Skills": ";".join(skills),
                "Engagement": random.randint(*ranges["eng"]),
                "Overtime": random.randint(*ranges["ot"]),
                "Growth": random.randint(*ranges["gr"]),
                "ManagerSupport": random.randint(*ranges["ms"]),
                "Performance": random.randint(55, 92),
                "Tenure": random.randint(3, 60),
                "OpenPositions": 0,
            })
    df = pd.DataFrame(rows)
    # a handful of open reqs per department, independent of headcount rows
    open_reqs = {"Engineering": 34, "Sales": 22, "Marketing": 9, "Finance": 12, "HR": 9}
    df["OpenPositions"] = df["Department"].map(open_reqs)
    return df


def _clamp(v, lo=0, hi=100):
    return max(lo, min(hi, v))


def compute_metrics(df: pd.DataFrame, source_label: str):
    """Turn a raw employee dataframe into every number the UI needs."""
    if df is None or len(df) == 0:
        return {
            "source": source_label,
            "total_employees": 0,
            "attrition_risk": 0,
            "open_positions": 0,
            "skill_gaps": 0,
            "workforce_health": 0,
            "skill_coverage": 0,
            "departments": {},
            "employees": [],
        }

    df = df.copy()
    for col, default in DEFAULTS.items():
        if col not in df.columns:
            df[col] = default
        df[col] = df[col].fillna(default)
    for col in ["Engagement", "Overtime", "Growth", "ManagerSupport", "Performance", "Tenure", "OpenPositions"]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(DEFAULTS.get(col, 0))

    df["SkillList"] = df["Skills"].fillna("").apply(
        lambda s: [x.strip() for x in re.split(r"[;,]", str(s)) if x.strip()]
    )
    df["RiskScore"] = df.apply(lambda r: round(_clamp(
        0.30 * (100 - r["Engagement"]) + 0.30 * r["Overtime"] +
        0.20 * (100 - r["Growth"]) + 0.20 * (100 - r["ManagerSupport"])
    )), axis=1)
    df["MissingCritical"] = df["SkillList"].apply(lambda sk: [s for s in CRITICAL_SKILLS if s not in sk])

    departments = {}
    for dept, g in df.groupby("Department"):
        risk = round(g["RiskScore"].mean())
        level = "high" if risk >= 60 else "medium" if risk >= 35 else "low"
        departments[dept] = {
            "risk": risk,
            "level": level,
            "headcount": int(len(g)),
            "open_positions": int(g["OpenPositions"].iloc[0]) if "OpenPositions" in g else 0,
            "factors": {
                "Engagement": round(g["Engagement"].mean()),
                "Overtime": round(g["Overtime"].mean()),
                "Growth": round(g["Growth"].mean()),
                "Manager Support": round(g["ManagerSupport"].mean()),
            },
        }

    total_employees = int(len(df))
    overall_avg_risk = float(df["RiskScore"].mean()) if total_employees else 0
    attrition_risk = round(overall_avg_risk * 0.22, 1)
    workforce_health = round(_clamp(100 - overall_avg_risk))

    # Skill coverage / gaps measured at department level: for each department,
    # a critical skill counts as "covered" if at least 30% of that department
    # has it. This avoids penalizing employees for skills outside their role
    # (e.g. Sales isn't expected to know MLOps).
    gap_count = 0
    total_checks = 0
    for dept, g in df.groupby("Department"):
        dept_size = len(g)
        for skill in CRITICAL_SKILLS:
            total_checks += 1
            have = sum(1 for skills in g["SkillList"] if skill in skills)
            if dept_size == 0 or (have / dept_size) < 0.3:
                gap_count += 1
    skill_coverage = round(100 * (total_checks - gap_count) / total_checks) if total_checks else 0
    skill_gaps = gap_count
    open_positions = int(df.drop_duplicates("Department")["OpenPositions"].sum())

    employees = []
    for _, r in df.iterrows():
        employees.append({
            "name": r["Name"],
            "department": r["Department"],
            "role": r.get("Role", "Employee"),
            "skills": r["SkillList"],
            "missing_critical": r["MissingCritical"][:3],
            "engagement": int(r["Engagement"]),
            "overtime": int(r["Overtime"]),
            "growth": int(r["Growth"]),
            "manager_support": int(r["ManagerSupport"]),
            "performance": int(r["Performance"]),
            "risk": int(r["RiskScore"]),
        })

    return {
        "source": source_label,
        "total_employees": total_employees,
        "attrition_risk": attrition_risk,
        "open_positions": open_positions,
        "skill_gaps": skill_gaps,
        "workforce_health": workforce_health,
        "skill_coverage": skill_coverage,
        "departments": departments,
        "employees": employees,
    }


# In-memory "current dataset". Starts EMPTY — nobody sees anyone else's data
# or a pre-filled demo unless they explicitly ask for it (POST /api/demo).
# STATE["rows"] holds the raw records so single employees can be appended;
# STATE["metrics"] is the computed, ready-for-the-UI version.
STATE = {"rows": [], "metrics": compute_metrics(pd.DataFrame(), "No Data Yet")}


def _recompute(source_label: str):
    df = pd.DataFrame(STATE["rows"])
    STATE["metrics"] = compute_metrics(df, source_label)
    return STATE["metrics"]


def _auth_headers():
    return {"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"}


def list_groq_models():
    """IDs of chat models this key can actually use right now."""
    res = requests.get(GROQ_MODELS_URL, headers=_auth_headers(), timeout=10)
    res.raise_for_status()
    ids = []
    for m in res.json().get("data", []):
        mid = m.get("id", "")
        if m.get("active", True) and mid and not any(x in mid.lower() for x in NOT_CHAT_MODELS):
            ids.append(mid)
    return ids


def pick_model(ids, avoid=None):
    ids = [i for i in ids if i != avoid]
    for pref in MODEL_PREFERENCE:
        if pref in ids:
            return pref
    non_tool = [i for i in ids if "compound" not in i]
    return (non_tool or ids or [None])[0]


def resolve_model(force=False, avoid=None):
    """Use GROQ_MODEL if it's set to something real and available; otherwise pick the best available."""
    if MODEL_STATE["resolved"] and not force:
        return MODEL_STATE["resolved"]
    chosen = None
    try:
        ids = list_groq_models()
        if GROQ_MODEL.lower() != "auto" and GROQ_MODEL in ids and GROQ_MODEL != avoid:
            chosen = GROQ_MODEL
        else:
            chosen = pick_model(ids, avoid)
            if chosen and GROQ_MODEL.lower() != "auto" and GROQ_MODEL not in ids:
                print(f"Model '{GROQ_MODEL}' isn't available to your key. Using '{chosen}' instead.")
    except Exception as e:
        print("Could not list Groq models:", type(e).__name__, e)
    if not chosen:  # couldn't discover anything; fall back to a sensible default
        chosen = GROQ_MODEL if GROQ_MODEL.lower() != "auto" else MODEL_PREFERENCE[0]
    MODEL_STATE["resolved"] = chosen
    return chosen


def _clean_reply(text):
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S | re.I)
    return text.strip()


def call_groq(system_prompt: str, user_prompt: str, max_tokens: int = 500):
    """Call Groq. Returns text, or None on any failure (reason saved in LAST_GROQ_ERROR)."""
    problem = groq_key_problem()
    if problem:
        LAST_GROQ_ERROR["msg"] = problem
        return None
    model = resolve_model()
    for attempt in (1, 2):
        try:
            payload = {
                "model": model,
                "messages": [{"role": "system", "content": system_prompt},
                             {"role": "user", "content": user_prompt}],
                "max_tokens": max_tokens,
                "temperature": 0.4,
            }
            low = model.lower()
            if any(k in low for k in REASONING_MARKERS):
                payload["max_tokens"] = max(max_tokens, 800)  # thinking tokens count against the limit
                if "gpt-oss" in low:
                    payload["reasoning_effort"] = "low"
            res = requests.post(GROQ_URL, headers=_auth_headers(), json=payload, timeout=30)
            if res.status_code != 200:
                try:
                    detail = res.json().get("error", {}).get("message", res.text[:200])
                except Exception:
                    detail = res.text[:200]
                # Retired/unavailable model -> rediscover once and retry with another one
                if attempt == 1 and res.status_code in (400, 403, 404) and "model" in detail.lower():
                    new_model = resolve_model(force=True, avoid=model)
                    if new_model and new_model != model:
                        print(f"Model '{model}' failed ({detail[:80]}). Switching to '{new_model}'.")
                        model = new_model
                        continue
                LAST_GROQ_ERROR["msg"] = f"Groq returned {res.status_code}: {detail}"
                print("Groq call failed:", LAST_GROQ_ERROR["msg"])
                return None
            text = _clean_reply(res.json()["choices"][0]["message"].get("content"))
            if not text:
                LAST_GROQ_ERROR["msg"] = f"Model '{model}' returned an empty reply."
                return None
            LAST_GROQ_ERROR["msg"] = None
            return text
        except Exception as e:
            LAST_GROQ_ERROR["msg"] = f"Could not reach Groq ({type(e).__name__}). Check your internet connection."
            print("Groq call failed:", LAST_GROQ_ERROR["msg"])
            return None
    return None


# Always answer with JSON (never an HTML error page) so the UI can show the real reason.
@app.errorhandler(Exception)
def handle_any_error(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        if request.path.startswith("/api/"):
            return jsonify({"error": f"{e.code} {e.name}: {e.description}"}), e.code
        return e
    import traceback
    traceback.print_exc()
    return jsonify({"error": f"Server error: {type(e).__name__}: {e}"}), 500


# ---------------------------------------------------------------------------
# Dataset endpoints
# ---------------------------------------------------------------------------
@app.route("/api/dataset", methods=["GET"])
def get_dataset():
    return jsonify(STATE["metrics"])


@app.route("/api/upload", methods=["POST"])
def upload_dataset():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded. Attach a .csv or .xlsx file under the 'file' field."}), 400
    f = request.files["file"]
    filename = f.filename or "uploaded"
    try:
        if filename.lower().endswith(".csv"):
            df = pd.read_csv(f)
        elif filename.lower().endswith((".xlsx", ".xls")):
            df = pd.read_excel(f)
        else:
            return jsonify({"error": "Unsupported file type. Upload a .csv or .xlsx file."}), 400
    except Exception as e:
        return jsonify({"error": f"Could not read the file: {e}"}), 400

    missing_cols = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing_cols:
        return jsonify({
            "error": f"Missing required column(s): {', '.join(missing_cols)}. "
                     f"At minimum your file needs 'Name' and 'Department' columns."
        }), 400
    if len(df) == 0:
        return jsonify({"error": "The file has no rows."}), 400

    STATE["rows"] = df.to_dict("records")
    return jsonify(_recompute(filename))


@app.route("/api/employees/add", methods=["POST"])
def add_employee():
    """Add a single employee via the step-by-step form. Appends to whatever
    dataset is currently loaded (starts empty for every new visitor)."""
    data = request.get_json(force=True) or {}
    name = (data.get("name") or "").strip()
    department = (data.get("department") or "").strip()
    if not name or not department:
        return jsonify({"error": "Name and Department are required."}), 400

    def _num(key, default):
        try:
            v = data.get(key, None)
            return default if v in (None, "") else float(v)
        except (TypeError, ValueError):
            return default

    row = {
        "Name": name,
        "Department": department,
        "Role": (data.get("role") or "Employee").strip(),
        "Skills": (data.get("skills") or "").strip(),
        "Engagement": _num("engagement", DEFAULTS["Engagement"]),
        "Overtime": _num("overtime", DEFAULTS["Overtime"]),
        "Growth": _num("growth", DEFAULTS["Growth"]),
        "ManagerSupport": _num("managerSupport", DEFAULTS["ManagerSupport"]),
        "Performance": _num("performance", DEFAULTS["Performance"]),
        "Tenure": _num("tenure", DEFAULTS["Tenure"]),
        "OpenPositions": _num("openPositions", 0),
    }
    STATE["rows"].append(row)
    label = STATE["metrics"]["source"] if STATE["metrics"]["total_employees"] > 0 else "Your Data"
    if label in ("No Data Yet",):
        label = "Your Data"
    return jsonify(_recompute(label))


@app.route("/api/demo", methods=["POST"])
def load_demo_dataset():
    """Explicit opt-in only — never loaded automatically for a new visitor."""
    STATE["rows"] = _generate_demo_dataframe().to_dict("records")
    return jsonify(_recompute("Demo Dataset"))


@app.route("/api/clear", methods=["POST"])
def clear_dataset():
    STATE["rows"] = []
    return jsonify(_recompute("No Data Yet"))


# ---------------------------------------------------------------------------
# AI Workforce Insight (Command Center)
# ---------------------------------------------------------------------------
@app.route("/api/insight", methods=["POST"])
def insight():
    m = STATE["metrics"]
    if m["total_employees"] == 0:
        return jsonify({"summary": "No workforce data yet. Add an employee or upload a file to generate an AI insight."})
    ai_text = call_groq(
        "You are TalentMind AI, an enterprise HR intelligence assistant. Given structured "
        "workforce data, write ONE concise (2-3 sentence) executive insight highlighting the "
        "most important risk or trend, and name specific numbers.",
        f"Workforce data: {json.dumps(m)}\nWrite the insight now.",
    )
    if not ai_text:
        top_dept = max(m["departments"].items(), key=lambda kv: kv[1]["risk"], default=(None, None))
        if top_dept[0]:
            ai_text = (f"{top_dept[0]} shows the highest attrition risk ({top_dept[1]['risk']}/100), driven by "
                        f"overtime at {top_dept[1]['factors']['Overtime']}% and manager support at "
                        f"{top_dept[1]['factors']['Manager Support']}%. Workforce health sits at "
                        f"{m['workforce_health']}/100 across {m['total_employees']} employees.")
        else:
            ai_text = "Upload workforce data to generate a live AI insight."
    return jsonify({"summary": ai_text.strip()})


# ---------------------------------------------------------------------------
# AI Recruitment Intelligence (independent of the uploaded workforce dataset)
# ---------------------------------------------------------------------------
KNOWN_SKILLS = ["Python", "AWS", "React", "SQL", "Power BI", "Cloud", "Azure", "Machine Learning",
                 "Docker", "Kubernetes", "Java", "Spring Boot", "REST APIs", "System Design",
                 "GraphQL", "Excel", "Predictive Modeling", "A/B Testing", "MLOps", "LLM Deployment",
                 "PostgreSQL", "JavaScript", "TypeScript", "Node.js"]


def extract_skills(text: str):
    text = text or ""
    return [s for s in KNOWN_SKILLS if re.search(re.escape(s), text, re.IGNORECASE)]


@app.route("/api/recruitment/match", methods=["POST"])
def recruitment_match():
    data = request.get_json(force=True)
    jd, resume = data.get("jd", ""), data.get("resume", "")
    jd_skills = extract_skills(jd)
    resume_skills = extract_skills(resume)
    matched = [s for s in jd_skills if s in resume_skills]
    missing = [s for s in jd_skills if s not in resume_skills]
    skill_pct = round((len(matched) / max(len(jd_skills), 1)) * 100)
    exp_pct = 75
    exp_match = re.search(r"(\d+)\+?\s*years?", resume, re.IGNORECASE)
    if exp_match:
        exp_pct = min(98, 60 + int(exp_match.group(1)) * 4)
    overall = round(skill_pct * 0.65 + exp_pct * 0.35)
    return jsonify({
        "overall_score": overall, "skill_match": skill_pct, "experience_match": exp_pct,
        "required_total": len(jd_skills), "required_met": len(matched),
        "matched_skills": matched, "missing_skills": missing,
    })


# ---------------------------------------------------------------------------
# Skill Gap Analyzer + Growth Plan (manual text-box version, unchanged)
# ---------------------------------------------------------------------------
@app.route("/api/skills/gap", methods=["POST"])
def skills_gap():
    data = request.get_json(force=True)
    current = [s.strip() for s in data.get("current", "").split(",") if s.strip()]
    target = [s.strip() for s in data.get("target", "").split(",") if s.strip()]
    matched = [s for s in target if s.lower() in [c.lower() for c in current]]
    missing = [s for s in target if s.lower() not in [c.lower() for c in current]]

    plan_text = call_groq(
        "You are an HR learning-and-development planner. Given a list of missing skills, output "
        'ONLY a JSON array like [{"month":"Month 1","skill":"..."}] with one entry per missing '
        "skill, in logical learning order. No prose, only JSON.",
        f"Missing skills: {missing}", max_tokens=300,
    )
    plan = None
    if plan_text:
        try:
            cleaned = re.sub(r"^json", "", plan_text.strip().strip("`").strip(), flags=re.IGNORECASE).strip()
            plan = json.loads(cleaned)
        except Exception:
            plan = None
    if not plan:
        plan = [{"month": f"Month {i+1}", "skill": f"{s} Fundamentals"} for i, s in enumerate(missing)]
    return jsonify({"matched": matched, "missing": missing, "plan": plan})


# ---------------------------------------------------------------------------
# Attrition Prediction + Explainable AI (reads current dataset)
# ---------------------------------------------------------------------------
@app.route("/api/attrition/predict", methods=["POST"])
def attrition_predict():
    data = request.get_json(force=True)
    dept = data.get("dept")
    m = STATE["metrics"]
    info = m["departments"].get(dept)
    if not info:
        return jsonify({"error": f"No data for '{dept}' in the current dataset."}), 404

    ai_text = call_groq(
        "You are an HR explainable-AI assistant. Given a department's risk factors (0-100 scale), "
        "explain in 1-2 sentences WHY the attrition risk is at this level, referencing the factors.",
        f"Department: {dept}, Risk score: {info['risk']}/100, Level: {info['level']}, Factors: {info['factors']}",
        max_tokens=200,
    )
    answer = ai_text.strip() if ai_text else (
        f"Attrition risk is {info['level']} due to the combination of engagement, overtime, "
        f"growth, and manager-support signals shown below."
    )
    return jsonify({"risk": info["risk"], "level": info["level"], "answer": answer, "factors": info["factors"]})


# ---------------------------------------------------------------------------
# Ask Your Workforce Data (reads current dataset)
# ---------------------------------------------------------------------------
def _top_driver(info):
    """The factor hurting a department most (high overtime, or low engagement/growth/support)."""
    f = info["factors"]
    badness = {"Overtime": f["Overtime"], "Engagement": 100 - f["Engagement"],
               "Growth": 100 - f["Growth"], "Manager Support": 100 - f["Manager Support"]}
    name = max(badness, key=badness.get)
    return name, f[name]


GREETING_RE = re.compile(r"^\s*(hi|hii+|hello|hey|hola|namaste|good (morning|afternoon|evening)|yo)\b[\s!.?]*$", re.I)


@app.route("/api/ask", methods=["POST"])
def ask():
    data = request.get_json(force=True, silent=True) or {}
    question = (data.get("question") or "").strip()
    m = STATE["metrics"]
    if not question:
        return jsonify({"answer": "Type a question and I'll look into it.", "ai": False}), 400
    if GREETING_RE.match(question):
        hint = ("Add an employee or upload a file above and I can answer questions about your workforce."
                if m["total_employees"] == 0 else
                f"I have {m['total_employees']} employee{'s' if m['total_employees'] != 1 else ''} loaded. Try: \"Which department has the highest attrition risk?\"")
        return jsonify({"answer": f"Hi! I'm TalentMind AI, your HR intelligence assistant. {hint}", "ai": False})
    if m["total_employees"] == 0:
        return jsonify({"answer": "There's no workforce data loaded yet. Add an employee or upload a file above, then ask again.", "ai": False})
    ai_text = call_groq(
        "You are TalentMind AI's workforce data assistant. Answer the HR question using ONLY the "
        "provided structured workforce data. Structure: direct answer, cite specific numbers as "
        "evidence, then one recommended action. Under 80 words.",
        f"Workforce data: {json.dumps(m)}\nQuestion: {question}", max_tokens=250,
    )
    used_ai = bool(ai_text)
    if not ai_text:
        top_dept = max(m["departments"].items(), key=lambda kv: kv[1]["risk"], default=(None, None))
        drv, val = _top_driver(top_dept[1])
        ai_text = (f"{top_dept[0]} has the highest attrition risk at {top_dept[1]['risk']}/100, "
                    f"mainly driven by {drv.lower()} ({val}%). Recommended "
                    f"action: prioritize a retention review in {top_dept[0]} this month.")
    return jsonify({"answer": ai_text.strip(), "ai": used_ai,
                     "ai_error": None if used_ai else LAST_GROQ_ERROR["msg"]})


# ---------------------------------------------------------------------------
# HR Policy Reasoning Agent (unchanged — reasons over pasted policy text)
# ---------------------------------------------------------------------------
@app.route("/api/policy/ask", methods=["POST"])
def policy_ask():
    data = request.get_json(force=True)
    doc = data.get("doc", "")
    question = data.get("question", "")
    ai_text = call_groq(
        "You are an HR policy assistant. Answer the question using ONLY the provided policy text. "
        "If the answer isn't in the text, say so. Be concise (1-2 sentences) and quote the relevant figure.",
        f"Policy text: {doc}\nQuestion: {question}", max_tokens=200,
    )
    if not ai_text:
        sentences = [s.strip() for s in re.split(r"\.(?=\s|$)", doc) if s.strip()]
        q_words = [w for w in re.findall(r"\w+", question.lower()) if len(w) > 3]
        best, best_score = (sentences[0] if sentences else ""), -1
        for s in sentences:
            score = sum(1 for w in q_words if w in s.lower())
            if score > best_score:
                best_score, best = score, s
        ai_text = best + "."
    return jsonify({"answer": ai_text.strip(), "source": "Pasted Policy Document"})


# ---------------------------------------------------------------------------
# Workforce Digital Twin — before/after simulation with an AI recommendation
# ---------------------------------------------------------------------------
COST_PER_EMPLOYEE_INR = 900000  # rough illustrative fully-loaded annual cost


def _risk_level(attrition_pct):
    return "High" if attrition_pct > 18 else "Medium" if attrition_pct > 12 else "Low"


@app.route("/api/whatif", methods=["POST"])
def whatif():
    data = request.get_json(force=True)
    hire = float(data.get("hire", 0))          # Engineering hiring change %
    train = float(data.get("train", 0))        # Training investment change %
    remote = float(data.get("remote", 0))      # Remote employees change %
    attrition_target = float(data.get("attritionAdj", 0))  # desired attrition reduction %

    m = STATE["metrics"]
    if m["total_employees"] == 0:
        return jsonify({"error": "Add workforce data first so there's a baseline to simulate from."}), 400

    before = {
        "attrition": m["attrition_risk"],
        "skill_coverage": m["skill_coverage"],
        "hiring_demand": m["open_positions"],
        "cost": m["total_employees"] * COST_PER_EMPLOYEE_INR,
        "risk": _risk_level(m["attrition_risk"]),
    }

    attrition_after = max(2.0, round(
        before["attrition"] - train * 0.05 + hire * 0.04 - attrition_target * 0.8 - remote * 0.02, 1
    ))
    skill_after = min(98, max(0, round(before["skill_coverage"] + train * 0.4 + remote * 0.05)))
    hiring_after = max(0, round(before["hiring_demand"] - hire * 0.6))
    cost_multiplier = 1 + (hire / 100 * 0.5) + (train / 100 * 0.1) - (remote / 100 * 0.03)
    cost_after = round(before["cost"] * max(0.5, cost_multiplier))

    after = {
        "attrition": attrition_after,
        "skill_coverage": skill_after,
        "hiring_demand": hiring_after,
        "cost": cost_after,
        "risk": _risk_level(attrition_after),
    }

    ai_text = call_groq(
        "You are TalentMind AI's simulation reasoning engine. Given a workforce 'before' and 'after' "
        "scenario resulting from specific HR lever changes, write ONE confident sentence (max 35 words) "
        "recommending or summarizing the projected outcome. Reference the changed levers and the biggest "
        "improvement. Do not hedge excessively; this is a labeled scenario estimate already.",
        f"Levers: Engineering hiring {hire:+.0f}%, Training investment {train:+.0f}%, "
        f"Remote employees {remote:+.0f}%, Attrition target {attrition_target:+.0f}%. "
        f"Before: {before}. After: {after}.",
        max_tokens=120,
    )
    if not ai_text:
        deltas = []
        if train > 0: deltas.append("expanding training investment")
        if hire > 0: deltas.append("increasing Engineering hiring")
        if remote != 0: deltas.append(f"{'raising' if remote>0 else 'reducing'} remote headcount")
        lever_text = " and ".join(deltas) if deltas else "the selected changes"
        ai_text = (f"{lever_text.capitalize()} is projected to move attrition risk from "
                    f"{before['attrition']}% to {after['attrition']}% and skill coverage from "
                    f"{before['skill_coverage']}% to {after['skill_coverage']}%.")

    return jsonify({"before": before, "after": after, "recommendation": ai_text.strip()})


# ---------------------------------------------------------------------------
# Employee Skill DNA — personalized per employee
# ---------------------------------------------------------------------------
def _skill_proficiency(name: str, skill: str, performance: int) -> int:
    """Deterministic pseudo-random proficiency so the same employee+skill
    always renders the same %, without needing real assessment data."""
    seed = int(hashlib.md5(f"{name}:{skill}".encode()).hexdigest(), 16) % 21  # 0-20
    base = 55 + (performance - 50) * 0.4  # performance nudges proficiency
    return int(_clamp(round(base + seed)))


@app.route("/api/skill-dna", methods=["POST"])
def skill_dna():
    data = request.get_json(force=True)
    index = data.get("index")
    m = STATE["metrics"]
    if m["total_employees"] == 0 or index is None or not (0 <= int(index) < len(m["employees"])):
        return jsonify({"error": "No employee selected or no data loaded."}), 400

    emp = m["employees"][int(index)]
    skills = emp["skills"] or []
    proficiencies = sorted(
        [{"skill": s, "pct": _skill_proficiency(emp["name"], s, emp["performance"])} for s in skills],
        key=lambda x: -x["pct"]
    )
    ai_readiness = int(_clamp(round(
        0.30 * emp["performance"] + 0.25 * emp["engagement"] + 0.25 * emp["growth"] +
        0.20 * (100 - len(emp["missing_critical"]) * 15)
    )))
    strengths = [p["skill"] for p in proficiencies[:3]] or ["No skills listed yet"]
    gaps = emp["missing_critical"] or []

    ai_text = call_groq(
        "You are TalentMind AI's career development assistant. Given one employee's strengths and skill "
        "gaps, write ONE concise recommended next step (max 30 words) — a specific, actionable learning "
        "path or project.",
        f"Employee: {emp['name']}, Role: {emp['role']}, Strengths: {strengths}, Gaps: {gaps}",
        max_tokens=100,
    )
    if not ai_text:
        if gaps:
            ai_text = f"Complete a {gaps[0]} learning pathway and apply it in one live project over the next quarter."
        else:
            ai_text = "Strong all-round coverage — consider a stretch project or mentoring a teammate on a critical skill."

    return jsonify({
        "name": emp["name"], "role": emp["role"], "department": emp["department"],
        "proficiencies": proficiencies, "ai_readiness": ai_readiness,
        "strengths": strengths, "gaps": gaps, "recommended_next_step": ai_text.strip(),
    })


# ---------------------------------------------------------------------------
# AI Agent Mission Control — structured multi-agent investigation
# ---------------------------------------------------------------------------
@app.route("/api/investigate", methods=["POST"])
def investigate():
    data = request.get_json(force=True)
    question = data.get("question", "")
    m = STATE["metrics"]
    if m["total_employees"] == 0:
        return jsonify({"error": "Add workforce data first so agents have something to investigate."}), 400

    dept = None
    for d in m["departments"]:
        if d.lower() in question.lower():
            dept = d
            break
    if not dept:
        dept = max(m["departments"].items(), key=lambda kv: kv[1]["risk"])[0]
    info = m["departments"][dept]

    ai_text = call_groq(
        "You are TalentMind AI's multi-agent investigation summarizer. Given a department's risk data, "
        "return a JSON object with EXACTLY these keys: evidence (array of 2-3 short strings), "
        "factors (array of 2-3 short strings naming contributing factors), "
        "actions (array of 2-3 short recommended-action strings). No prose outside the JSON.",
        f"Department: {dept}, Risk: {info['risk']}/100, Level: {info['level']}, Factors: {info['factors']}",
        max_tokens=300,
    )
    evidence, factors, actions = None, None, None
    if ai_text:
        try:
            cleaned = re.sub(r"^json", "", ai_text.strip().strip("`").strip(), flags=re.IGNORECASE).strip()
            parsed = json.loads(cleaned)
            evidence, factors, actions = parsed.get("evidence"), parsed.get("factors"), parsed.get("actions")
        except Exception:
            pass
    if not evidence:
        evidence = [
            f"Overtime in {dept} averages {info['factors']['Overtime']}%, above the healthy threshold.",
            f"Manager support scores {info['factors']['Manager Support']}%, below target for a {info['level']}-risk team.",
        ]
    if not factors:
        factors = [k for k, v in sorted(info["factors"].items(), key=lambda kv: -kv[1] if kv[0] == "Overtime" else kv[1])][:3]
    if not actions:
        actions = [f"Review {dept} workload distribution", "Schedule career-growth conversations",
                   "Increase manager check-in cadence"]

    return jsonify({
        "department": dept, "risk_level": info["level"], "risk_score": info["risk"],
        "evidence": evidence, "factors": factors, "actions": actions,
    })


# ---------------------------------------------------------------------------
# Executive Report Generator (reads current dataset)
# ---------------------------------------------------------------------------
@app.route("/api/report", methods=["POST"])
def report():
    m = STATE["metrics"]
    if m["total_employees"] == 0:
        return jsonify({"report": "No workforce data loaded yet. Add employees or upload a file, then generate the report again."})
    ai_text = call_groq(
        "You are TalentMind AI. Write a concise executive workforce report with these sections: "
        "Workforce Overview, Top Risks, Skill Gaps, Attrition Trends, Performance Insights, "
        "Recommended Actions. Use the provided data. Keep each section to 1-2 sentences.",
        f"Workforce data: {json.dumps(m)}", max_tokens=500,
    )
    if not ai_text:
        top_dept = max(m["departments"].items(), key=lambda kv: kv[1]["risk"], default=(None, {}))
        ai_text = (
            f"Workforce Overview: {m['total_employees']} employees, {m['workforce_health']}/100 health score, "
            f"{m['attrition_risk']}% attrition risk.\n\n"
            f"Top Risks: {top_dept[0] or 'N/A'} attrition ({(top_dept[1] or {}).get('risk','—')}/100).\n\n"
            f"Skill Gaps: {m['skill_gaps']} employees with critical skill gaps; overall skill coverage "
            f"{m['skill_coverage']}%.\n\n"
            f"Open Positions: {m['open_positions']} roles currently open.\n\n"
            f"Recommended Actions: workload review in the highest-risk department, a targeted "
            f"upskilling cohort, and increased manager check-in cadence."
        )
    return jsonify({"report": ai_text.strip()})


@app.route("/api/health", methods=["GET"])
def health():
    problem = groq_key_problem()
    ai = {"state": "missing" if problem else "unchecked", "detail": problem}
    if not problem and request.args.get("check"):
        out = call_groq("Reply with the single word: ok", "ping", max_tokens=5)
        ai = {"state": "ok", "detail": None} if out else {"state": "error", "detail": LAST_GROQ_ERROR["msg"]}
    return jsonify({"status": "ok", "ai": ai, "model": MODEL_STATE["resolved"] or GROQ_MODEL,
                     "dataset_source": STATE["metrics"]["source"],
                     "employees": STATE["metrics"]["total_employees"]})


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    problem = groq_key_problem()
    print("\n" + "=" * 60)
    print(" TalentMind AI is starting")
    print(f"  Open in your browser:  http://127.0.0.1:{port}")
    print("  AI (Groq):", "READY (key found)" if not problem else "NOT READY -> " + problem)
    print("  Keep this window open while you use the site.")
    print("=" * 60 + "\n")
    app.run(host="127.0.0.1", port=port, debug=False)
