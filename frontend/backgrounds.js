/* TalentMind AI — background: Aurora (fixed style, no picker). */
(function(){
"use strict";

const TAU = Math.PI * 2;
const rnd = (a, b) => a + Math.random() * (b - a);
const C = { cyan:[60,224,255], blue:[79,140,255], purple:[167,139,250] };
const rgba = (c, a) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(3) + ")";

function createAurora(w, h){
  const rib = [
    { c:C.cyan,   base:.30, amp:.09, f:1.2, sp:.045, th:.30, ph:0.0, a:.20 },
    { c:C.blue,   base:.44, amp:.11, f:.9,  sp:.038, th:.34, ph:1.7, a:.20 },
    { c:C.purple, base:.55, amp:.09, f:1.5, sp:.052, th:.28, ph:3.1, a:.17 },
    { c:C.cyan,   base:.68, amp:.07, f:1.1, sp:.030, th:.22, ph:4.4, a:.11 }
  ];
  const layers = [1, .72, .48, .26];
  const step = Math.max(8, w / 80);
  return { draw(ctx, t){
    ctx.globalCompositeOperation = "lighter";
    for(const r of rib){
      const pts = [];
      for(let x = 0; x <= w + step; x += step){
        const u = x / w;
        const y = h * r.base + Math.sin(u * TAU * r.f + t * r.sp * TAU + r.ph) * h * r.amp
                             + Math.sin(u * TAU * r.f * 2.3 - t * r.sp * 1.7 * TAU) * h * r.amp * .35;
        const th = h * r.th * (.72 + .28 * Math.sin(u * TAU * .8 + t * .15 + r.ph));
        pts.push([x, y, th]);
      }
      for(const L of layers){
        ctx.fillStyle = rgba(r.c, r.a / layers.length);
        ctx.beginPath();
        pts.forEach(([x, y, th], i) => { const yy = y - th * .35 * L; i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy); });
        for(let i = pts.length - 1; i >= 0; i--){ const [x, y, th] = pts[i]; ctx.lineTo(x, y + th * .65 * L); }
        ctx.closePath(); ctx.fill();
      }
    }
    ctx.globalCompositeOperation = "source-over";
  }};
}

function boot(){
  const canvas = document.getElementById("network-bg");
  if(!canvas) return;
  const ctx = canvas.getContext("2d");
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let w = 0, h = 0, inst = null, t0 = performance.now();

  function size(){
    const r = canvas.getBoundingClientRect();
    w = Math.max(20, Math.round(r.width)); h = Math.max(20, Math.round(r.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    inst = createAurora(w, h);
  }
  function frame(now){
    if(!inst) return;
    ctx.clearRect(0, 0, w, h);
    inst.draw(ctx, (now - t0) / 1000);
  }

  size();
  canvas.style.opacity = "0.9";
  if(reduce){ frame(performance.now() + 4000); }
  else (function loop(now){ frame(now); requestAnimationFrame(loop); })(performance.now());

  let rz;
  window.addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => { size(); if(reduce) frame(performance.now() + 4000); }, 120);
  });
}

if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
