import math, random, sys
random.seed(7)
W = 640; C = W/2
FS = 11            # font size
STEP = 8.5         # spacing between glyphs
BUCKETS = 32
PERIOD = 4.0       # seconds for one colour wave
glyphs = []        # (x, y, dist)

def add(x, y):
    glyphs.append((x, y, math.hypot(x-C, y-C)))

def disk(cx, cy, r, ring_only_inner=False):
    # concentric rings of glyphs
    add(cx, cy)
    k = 1
    while k*STEP <= r:
        rr = k*STEP
        n = max(6, int(2*math.pi*rr/STEP))
        off = random.random()*math.tau
        for i in range(n):
            a = off + i*math.tau/n
            add(cx+rr*math.cos(a), cy+rr*math.sin(a))
        k += 1

HUB_R = 52; NODE_R = 21; SPOKE = 230
angles = [-90, -27, 27, 90, 153, 207]
disk(C, C, HUB_R)
# outer hub rim, slightly denser
n = int(2*math.pi*(HUB_R+9)/7)
for i in range(n):
    a = i*math.tau/n
    add(C+(HUB_R+9)*math.cos(a), C+(HUB_R+9)*math.sin(a))
for deg in angles:
    a = math.radians(deg)
    d = HUB_R+20
    while d < SPOKE-NODE_R-6:
        add(C+d*math.cos(a), C+d*math.sin(a)); d += STEP
    disk(C+SPOKE*math.cos(a), C+SPOKE*math.sin(a), NODE_R)

maxd = max(g[2] for g in glyphs)
groups = {}   # (bucket, flip) -> list of (x,y,ch,alt)
for x, y, d in glyphs:
    b = int(d/maxd*(BUCKETS-1))
    flip = random.random() < 0.3
    ch = random.choice("01")
    groups.setdefault((b, flip), []).append((x, y, ch))

def text(items, chars, cls):
    return "".join(f'<text x="{x:.1f}" y="{y+FS*0.35:.1f}">{c}</text>' for (x, y, _), c in zip(items, chars))

css = [
 "text{font:700 %dpx ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-anchor:middle}.w{fill:#ff8a1f}" % FS,
 "@media (prefers-reduced-motion:reduce){.w,.a,.b{animation:none}.b{opacity:0}}",
 ".w{animation:rgb %.1fs linear infinite,pulse %.1fs ease-in-out infinite}" % (PERIOD, PERIOD/2),
 "@keyframes rgb{0%{fill:#ff3355}17%{fill:#ff9a1f}33%{fill:#ffe03a}50%{fill:#35ff7a}67%{fill:#2fc8ff}83%{fill:#8f5bff}100%{fill:#ff3355}}",
 "@keyframes pulse{0%,100%{opacity:.45}50%{opacity:1}}",
 ".b{opacity:0}.a{animation:fa 1.6s steps(1) infinite}.b{animation:fb 1.6s steps(1) infinite}",
 "@keyframes fa{0%{opacity:1}50%{opacity:0}}@keyframes fb{0%{opacity:0}50%{opacity:1}}",
]
for b in range(BUCKETS):
    css.append(f".d{b}{{animation-delay:-{(BUCKETS-b)/BUCKETS*PERIOD:.3f}s,-{(BUCKETS-b)/BUCKETS*PERIOD/2:.3f}s}}")

body = []
for (b, flip), items in sorted(groups.items()):
    chars = "".join(c for _, _, c in items)
    inner = []
    if flip:
        alt = "".join("1" if c == "0" else "0" for c in chars)
        inner.append(f'<g class="a">{text(items, chars, "")}</g>')
        inner.append(f'<g class="b">{text(items, alt, "")}</g>')
    else:
        inner.append(text(items, chars, ""))
    body.append(f'<g class="w d{b}">{"".join(inner)}</g>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {W}" width="{W//2}" height="{W//2}" role="img" aria-label="Vizor logo made of binary digits">
<title>Vizor</title>
<defs><filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<radialGradient id="bg" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#16110d"/><stop offset="1" stop-color="#050505"/></radialGradient></defs>
<style>{"".join(css)}</style>
<rect width="{W}" height="{W}" rx="48" fill="url(#bg)"/>
<g filter="url(#glow)">{"".join(body)}</g>
</svg>'''
open(sys.argv[1], "w").write(svg)
print(len(glyphs), "glyphs,", len(svg)//1024, "KB")
