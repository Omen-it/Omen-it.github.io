/*  OMEN — "Horizonte" · Vórtice Gravitacional
 *  Shader WebGL1 crudo que recrea con fidelidad el logo canónico de OMEN:
 *  - Horizonte de sucesos circular negro absoluto
 *  - Anillo de fotones ultra-brillante (halo de luz fría #9DB4C0)
 *  - 8 brazos espirales de acreción con curvatura logarítmica y filamentos orgánicos
 *  - Reactividad gravitacional al mouse (lerp) y timeline scrubber al scroll
 *  - Cero dependencias externas (< 8KB min)
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
    gl = canvas.getContext("webgl", { antialias: true, alpha: false, depth: false, powerPreference: "high-performance" })
      || canvas.getContext("experimental-webgl", { antialias: true, alpha: false });
  } catch (e) { gl = null; }

  if (!gl || reduce) return;

  document.documentElement.classList.add("bh-on");

  /* ---------- Shaders ---------- */
  var VERT = [
    "attribute vec2 a;",
    "void main(){ gl_Position = vec4(a, 0.0, 1.0); }"
  ].join("\n");

  var FRAG = [
    "precision highp float;",
    "uniform vec2  uRes;",
    "uniform float uTime;",
    "uniform vec2  uCenter;",
    "uniform float uRadius;",
    "uniform float uTilt;",
    "uniform float uBright;",
    "uniform float uSeed;",
    "uniform vec2  uMouse;",

    "float h21(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }",

    "void main(){",
    "  vec2 uv = (gl_FragCoord.xy - 0.5*uRes)/uRes.y;",
    "  vec2 p  = uv - uCenter;",
    "  float r = length(p);",
    "  float ang = atan(p.y, p.x);",
    "  float Rh = max(uRadius, 0.0008);",
    "  float aspect = uRes.x/uRes.y;",
    "  vec3 col = vec3(0.004, 0.004, 0.006);", // Fondo void OMEN #030304

    // ---- Campo de estrellas distantes tenue ----
    "  vec2 gs = uv*vec2(aspect,1.0)*10.0;",
    "  vec2 cell = floor(gs); vec2 fr = fract(gs);",
    "  float rnd = h21(cell + uSeed*2.1);",
    "  float has = step(0.92, rnd);",
    "  vec2 sp = vec2(h21(cell+1.3), h21(cell+2.7));",
    "  float d = length(fr - sp);",
    "  float tw = 0.5 + 0.5*sin(uTime*(0.6 + 2.0*h21(cell+3.7)) + rnd*24.0);",
    "  float star = has * smoothstep(0.04, 0.0, d) * (0.15 + 0.85*tw) * (0.3 + 0.7*h21(cell+5.5));",
    "  star *= smoothstep(Rh*2.0, Rh*4.5, r);", // No sobre el vórtice
    "  col += vec3(star) * 0.7;",

    // ---- VÓRTICE ESPIRAL CANÓNICO OMEN (REPRODUCCIÓN DEL LOGO) ----
    // Torsión logarítmica hacia el agujero negro
    "  float rNorm = r / Rh;",
    "  float twist = 3.6 / (pow(rNorm, 0.78) + 0.12);",
    "  float spin = uTime * 0.38;",
    "  float spiralAng = ang + twist - spin;",

    // 8 brazos espirales principales idénticos al logo
    "  float armWave = sin(spiralAng * 8.0);",
    "  float arms = pow(0.5 + 0.5 * armWave, 3.4);",

    // Filamentos finos secundarios de turbulencia de acreción
    "  float subWave = sin(spiralAng * 16.0 + rNorm * 8.0 - uTime * 0.55);",
    "  float filaments = arms * (0.70 + 0.30 * subWave);",

    // Envoltura radial: comienza justo fuera del horizonte y se extiende en zarcillos
    "  float env = smoothstep(1.02, 1.25, rNorm) * (1.0 - smoothstep(1.6, 4.4, rNorm));",
    "  float vortexIntensity = filaments * env * (1.8 / (rNorm * 0.75 + 0.25));",

    // Anillo de fotones brillante (anillo blanco-frío en el límite del horizonte)
    "  float photonRing = exp(-pow((r - Rh * 1.035) / (Rh * 0.038), 2.0)) * 2.8;",

    // Resplandor difuso interior
    "  float innerGlow = exp(-pow((r - Rh * 1.15) / (Rh * 0.22), 2.0)) * 0.85;",

    // Halo frío tenue exterior
    "  float outerGlow = exp(-pow((r - Rh * 1.4) / (Rh * 0.9), 2.0)) * 0.32;",

    // Paleta de colores oficial OMEN
    "  vec3 signalCol = vec3(0.615, 0.706, 0.753);", // #9DB4C0
    "  vec3 coreCol   = vec3(0.96, 0.98, 1.00);",     // Blanco fotón

    "  vec3 vortexCol = mix(signalCol, coreCol, smoothstep(1.1, 1.9, rNorm) * 0.75) * vortexIntensity;",
    "  vortexCol += coreCol * photonRing;",
    "  vortexCol += signalCol * (innerGlow + outerGlow);",

    // Sombra del Horizonte de Sucesos: Negro absoluto puro en el núcleo
    "  float shadow = 1.0 - smoothstep(Rh * 0.985, Rh * 1.015, r);",
    "  vortexCol *= (1.0 - shadow);",

    "  col += vortexCol * uBright;",
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
    seed: gl.getUniformLocation(prog, "uSeed"),
    mouse: gl.getUniformLocation(prog, "uMouse")
  };
  gl.uniform1f(U.seed, Math.random() * 10.0);

  /* ---------- Resize & Viewport ---------- */
  var dprCap = 1.5;
  var scale = 1.0;
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

  /* ---------- Mouse Tracking (Reactividad Gravitacional) ---------- */
  var mouseX = 0, mouseY = 0;
  var targetMouseX = 0, targetMouseY = 0;
  window.addEventListener("mousemove", function (e) {
    targetMouseX = (e.clientX / innerWidth - 0.5) * 0.12;
    targetMouseY = -(e.clientY / innerHeight - 0.5) * 0.12;
  }, { passive: true });

  /* ---------- Keyframes del Timeline de Scroll ---------- */
  var isMobile = innerWidth < 760;
  var KF = [
    // Hero: En desktop se asienta al centro-derecha acompañando el titular; en móvil se centra
    { p: 0.00, cx: isMobile ? 0.00 : 0.19, cy: isMobile ? 0.12 : 0.03, r: isMobile ? 0.15 : 0.20, b: 1.15 },
    { p: 0.28, cx: 0.00, cy: 0.32, r: 0.13, b: 0.95 },  // Qué hacemos: cenital arriba
    { p: 0.56, cx: 0.00, cy: 0.00, r: 0.28, b: 1.25 },  // Manifiesto: fondo gravitacional
    { p: 0.82, cx: 0.00, cy: -0.18, r: 0.065, b: 1.05 }, // Caso / Concierge: colapso
    { p: 1.00, cx: 0.00, cy: 0.00, r: 0.008, b: 1.10 }   // Footer: punto singular
  ];

  window.addEventListener("resize", function () {
    isMobile = innerWidth < 760;
    KF[0].cx = isMobile ? 0.00 : 0.19;
    KF[0].cy = isMobile ? 0.12 : 0.03;
    KF[0].r  = isMobile ? 0.15 : 0.20;
  }, { passive: true });

  function sampleKF(p) {
    var a = KF[0], b = KF[KF.length - 1];
    for (var i = 0; i < KF.length - 1; i++) {
      if (p >= KF[i].p && p <= KF[i + 1].p) { a = KF[i]; b = KF[i + 1]; break; }
    }
    var span = (b.p - a.p) || 1;
    var k = clamp((p - a.p) / span, 0, 1);
    k = k * k * (3 - 2 * k);
    return {
      cx: lerp(a.cx, b.cx, k),
      cy: lerp(a.cy, b.cy, k),
      r: lerp(a.r, b.r, k),
      b: lerp(a.b, b.b, k)
    };
  }

  function scrollProg() {
    if (forcedProg !== null) return forcedProg;
    var max = document.documentElement.scrollHeight - innerHeight;
    var p = max > 0 ? window.scrollY / max : 0;
    return clamp(p, 0, 1);
  }

  /* ---------- Watchdog & Animation Loop ---------- */
  var slow = 0, lastT = performance.now();
  var running = true;

  document.addEventListener("visibilitychange", function () {
    running = !document.hidden;
    if (running) { lastT = performance.now(); requestAnimationFrame(frame); }
  });

  function frame(now) {
    if (!running) return;
    var dt = now - lastT; lastT = now;

    if (dt > 34) { slow++; } else { slow = Math.max(0, slow - 1); }
    if (slow > 45 && scale > 0.62) { scale = 0.62; slow = 0; resize(); }

    // Interacción suave con mouse
    mouseX = lerp(mouseX, targetMouseX, 0.045);
    mouseY = lerp(mouseY, targetMouseY, 0.045);

    var p = scrollProg();
    if (logScroll) console.log("[bh] prog", p.toFixed(3));
    var s = sampleKF(p);

    gl.uniform2f(U.res, W, H);
    gl.uniform1f(U.time, now * 0.001);
    gl.uniform2f(U.center, s.cx + mouseX, s.cy + mouseY);
    gl.uniform1f(U.radius, s.r);
    gl.uniform1f(U.tilt, 0.0);
    gl.uniform1f(U.bright, s.b);
    gl.uniform2f(U.mouse, mouseX, mouseY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }
})();
