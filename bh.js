/*  OMEN·IT — "Horizonte"
 *  Agujero negro procedimental ligado al scroll (WebGL1 crudo, sin librerías).
 *  Reconstrucción del efecto del sitio omen-it.tech.
 *
 *  Timeline (scroll-scrub):
 *    hero (centrado, dramático)
 *      -> vista cenital en "qué hacemos"
 *        -> full-bleed con lensing + flare en el manifiesto
 *          -> colapso hacia el caret del chat
 *            -> un punto en el footer
 *
 *  Degradación: sin WebGL o prefers-reduced-motion -> se deja el fallback CSS.
 *  Watchdog: baja la resolución si la GPU no da. DPR clamp 1.5. Pausa con pestaña oculta.
 *  QA:  ?bhp=0..1  fija el progreso   |  ?bhscroll=1  imprime el progreso en consola
 */
(function () {
  "use strict";

  var canvas = document.getElementById("bh");
  if (!canvas) return;

  var params = new URLSearchParams(location.search);
  var forcedProg = params.has("bhp") ? clamp(parseFloat(params.get("bhp")), 0, 1) : null;
  var logScroll = params.get("bhscroll") === "1";

  var reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var gl = null;
  try {
    gl = canvas.getContext("webgl", { antialias: false, alpha: false, depth: false, powerPreference: "high-performance" })
      || canvas.getContext("experimental-webgl", { antialias: false, alpha: false });
  } catch (e) { gl = null; }

  // Sin WebGL o movimiento reducido -> el fallback CSS de bh.css se queda tal cual.
  if (!gl || reduce) return;

  document.documentElement.classList.add("bh-on");

  /* ---------- shaders ---------- */
  var VERT = [
    "attribute vec2 a;",
    "void main(){ gl_Position = vec4(a, 0.0, 1.0); }"
  ].join("\n");

  var FRAG = [
    "precision highp float;",
    "uniform vec2  uRes;",
    "uniform float uTime;",
    "uniform vec2  uCenter;",   // centro en unidades y-normalizadas (y hacia arriba)
    "uniform float uRadius;",   // radio del horizonte de sucesos
    "uniform float uTilt;",     // 0 = de canto, 1 = cenital
    "uniform float uBright;",   // intensidad global
    "uniform float uSeed;",

    "float h21(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }",

    "void main(){",
    "  vec2 uv = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;",
    "  vec2 p  = uv - uCenter;",
    "  float r = length(p);",
    "  float ang = atan(p.y, p.x);",
    "  float Rh = max(uRadius, 0.0008);",
    "  float ny = p.y/(r+1e-4);",              // componente vertical normalizada
    "  float aspect = uRes.x/uRes.y;",
    "  vec3 col = vec3(0.0);",

    // ---- fondo NEGRO con estrellas dispersas que titilan ----
    "  vec2 gs = uv*vec2(aspect,1.0)*9.0;",
    "  vec2 cell = floor(gs); vec2 fr = fract(gs);",
    "  float rnd = h21(cell + uSeed*1.7);",
    "  float has = step(0.90, rnd);",                 // ~10% de las celdas tienen estrella
    "  vec2 sp = vec2(h21(cell+1.3), h21(cell+2.7));",
    "  float d = length(fr - sp);",
    "  float tw = 0.5 + 0.5*sin(uTime*(0.8 + 2.4*h21(cell+4.1)) + rnd*28.0);", // titileo
    "  float star = has * smoothstep(0.05, 0.0, d) * (0.2 + 0.8*tw) * (0.45 + 0.9*h21(cell+5.5));",
    "  star *= smoothstep(Rh*1.9, Rh*4.3, r);",       // no encima del agujero
    "  col += vec3(star) * 0.95;",

    // ---- disco de acreción: ANILLOS definidos (sin niebla), elipse por inclinación ----
    "  float sq = mix(0.12, 0.74, uTilt);",
    "  vec2 e = vec2(p.x, p.y/sq);",
    "  float er = length(e);",
    "  float Rin = Rh*1.16, Rout = Rh*3.10;",
    "  float t = (er - Rin)/(Rout - Rin);",                               // 0..1 dentro de la banda
    "  float band = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.80, 1.0, t));",
    "  float rings = pow(0.5 + 0.5*cos(t*52.0*6.28318), 3.0);",           // MUCHOS anillos finísimos y pegados
    "  rings *= 0.78 + 0.22*sin(t*160.0 + uTime*0.25);",                  // ligera variación entre anillos
    "  float disk = band * rings * (1.0 - 0.4*t);",                        // interiores un poco más brillantes
    "  disk *= 0.92 + 0.08*sin(ang*2.0 + uTime*0.3);",                     // shimmer rotacional muy fino
    // doppler: un lado mucho más brillante
    "  float dopp = 0.28 + 0.95*(0.5 - 0.5*cos(ang));",
    "  disk *= dopp;",
    // la mitad cercana (abajo) cruza POR DELANTE de la sombra; la lejana detrás se oculta
    "  float front = step(0.0, -p.y);",
    "  float behind = 1.0 - (step(0.0, p.y) * (1.0 - smoothstep(Rh, Rh*1.03, r)));",
    "  disk *= mix(behind, 1.0, front);",
    "  col += vec3(disk) * 1.5 * uBright;",

    // ---- arco lenseado del lado lejano, fino y arriba ----
    "  float arc = exp(-pow((r - Rh*1.16)/(Rh*0.075), 2.0)) * smoothstep(-0.15, 0.85, ny);",
    "  col += vec3(arc) * 0.6 * uBright;",

    // ---- anillo de fotones fino y brillante ----
    "  float pr = exp(-pow((r - Rh*1.04)/(Rh*0.03), 2.0));",
    "  col += vec3(pr) * 1.7 * uBright;",

    // ---- sombra: negro puro dentro del horizonte ----
    "  float shadow = 1.0 - smoothstep(Rh*0.97, Rh*1.005, r);",
    "  col *= (1.0 - shadow);",

    // clamp (sin filmic -> negros bien negros)
    "  col = clamp(col, 0.0, 1.0);",
    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("[bh] shader error:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  var vs = compile(gl.VERTEX_SHADER, VERT);
  var fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { document.documentElement.classList.remove("bh-on"); return; }

  var prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn("[bh] link error:", gl.getProgramInfoLog(prog));
    document.documentElement.classList.remove("bh-on");
    return;
  }
  gl.useProgram(prog);

  // triángulo de pantalla completa
  var buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  var aLoc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(aLoc);
  gl.vertexAttribPointer(aLoc, 2, gl.FLOAT, false, 0, 0);

  var U = {
    res: gl.getUniformLocation(prog, "uRes"),
    time: gl.getUniformLocation(prog, "uTime"),
    center: gl.getUniformLocation(prog, "uCenter"),
    radius: gl.getUniformLocation(prog, "uRadius"),
    tilt: gl.getUniformLocation(prog, "uTilt"),
    bright: gl.getUniformLocation(prog, "uBright"),
    seed: gl.getUniformLocation(prog, "uSeed")
  };
  gl.uniform1f(U.seed, Math.random() * 10.0);

  /* ---------- estado / resize ---------- */
  var dprCap = 1.5;
  var scale = 1.0;          // el watchdog lo baja si hay lag
  var W = 0, H = 0;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, dprCap) * scale;
    W = Math.max(1, Math.floor(innerWidth * dpr));
    H = Math.max(1, Math.floor(innerHeight * dpr));
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = innerWidth + "px";
    canvas.style.height = innerHeight + "px";
    gl.viewport(0, 0, W, H);
  }
  window.addEventListener("resize", resize, { passive: true });
  resize();

  /* ---------- keyframes del timeline ----------
   * cx/cy en unidades y-normalizadas (y hacia arriba). r = radio. t = tilt. b = brillo.
   */
  var KF = [
    { p: 0.00, cx: 0.16, cy: 0.06, r: 0.17, t: 0.20, b: 1.00 }, // hero
    { p: 0.28, cx: 0.00, cy: 0.34, r: 0.12, t: 0.85, b: 0.95 }, // servicios (cenital, arriba)
    { p: 0.56, cx: 0.00, cy: 0.00, r: 0.30, t: 0.45, b: 1.25 }, // manifiesto (full-bleed + flare)
    { p: 0.82, cx: 0.00, cy: -0.20, r: 0.055, t: 0.30, b: 1.05 }, // colapso al caret del chat
    { p: 1.00, cx: 0.00, cy: 0.00, r: 0.006, t: 0.50, b: 1.10 }  // punto en el footer
  ];

  function sampleKF(p) {
    var a = KF[0], b = KF[KF.length - 1];
    for (var i = 0; i < KF.length - 1; i++) {
      if (p >= KF[i].p && p <= KF[i + 1].p) { a = KF[i]; b = KF[i + 1]; break; }
    }
    var span = (b.p - a.p) || 1;
    var k = clamp((p - a.p) / span, 0, 1);
    k = k * k * (3 - 2 * k); // smoothstep
    return {
      cx: lerp(a.cx, b.cx, k),
      cy: lerp(a.cy, b.cy, k),
      r: lerp(a.r, b.r, k),
      t: lerp(a.t, b.t, k),
      b: lerp(a.b, b.b, k)
    };
  }

  function scrollProg() {
    if (forcedProg !== null) return forcedProg;
    var max = document.documentElement.scrollHeight - innerHeight;
    var p = max > 0 ? window.scrollY / max : 0;
    return clamp(p, 0, 1);
  }

  /* ---------- watchdog de rendimiento ---------- */
  var slow = 0, lastT = performance.now();

  var running = true;
  document.addEventListener("visibilitychange", function () {
    running = !document.hidden;
    if (running) { lastT = performance.now(); requestAnimationFrame(frame); }
  });

  function frame(now) {
    if (!running) return;
    var dt = now - lastT; lastT = now;

    // si vamos lento de forma sostenida, bajamos resolución una vez
    if (dt > 34) { slow++; } else { slow = Math.max(0, slow - 1); }
    if (slow > 45 && scale > 0.62) { scale = 0.62; slow = 0; resize(); }

    var p = scrollProg();
    if (logScroll) console.log("[bh] prog", p.toFixed(3));
    var s = sampleKF(p);

    gl.uniform2f(U.res, W, H);
    gl.uniform1f(U.time, now * 0.001);
    gl.uniform2f(U.center, s.cx, s.cy);
    gl.uniform1f(U.radius, s.r);
    gl.uniform1f(U.tilt, s.t);
    gl.uniform1f(U.bright, s.b);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- utils ---------- */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
})();
