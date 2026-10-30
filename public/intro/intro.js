(() => {
  "use strict";
  // One local timeline is shared by the browser and the native startup overlay.
  const timing = {
    assemble: 1350,
    color: 620,
    scope: 650,
    lock: 300,
    anticipate: 220,
    exit: 900,
    fade: 180,
  };
  const easing = {
    smooth: "cubic-bezier(0.22, 1, 0.36, 1)",
    settle: "cubic-bezier(0.34, 1.35, 0.64, 1)",
    speedRamp: "cubic-bezier(0.65, 0, 0.2, 1)",
    reveal: "cubic-bezier(0.4, 0, 0.2, 1)",
  };
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const $ = (selector) => document.querySelector(selector);
  const animations = new Set();
  document.body.classList.toggle("paused", document.hidden);
  let ready = false;
  let settled = false;
  let skipped = false;
  let exiting;
  let preparing;
  const animate = (element, frames, options) => {
    const animation = element.animate(frames, {
      fill: "forwards",
      easing: easing.smooth,
      ...options,
    });
    animations.add(animation);
    if (document.hidden) animation.pause();
    return animation.finished
      .catch(() => {})
      .finally(() => animations.delete(animation));
  };
  const notify = (type) => {
    if (window.parent !== window)
      window.parent.postMessage({ type }, location.origin);
  };
  // Clawd's block silhouette, including four feet and two little arms.
  const rows = [
    "000111111111111000",
    "001111111111111100",
    "011111111111111110",
    "011111111111111110",
    "011111111111111110",
    "011111111111111110",
    "111111111111111111",
    "111111111111111111",
    "101111111111111101",
    "000110110011011000",
    "000110110011011000",
  ];
  let index = 0;
  for (const [y, row] of rows.entries()) {
    for (const [x, cell] of [...row].entries()) {
      if (cell !== "1") continue;
      const pixel = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "rect",
      );
      pixel.setAttribute("x", String(x * 10));
      pixel.setAttribute("y", String(y * 10 + 5));
      pixel.setAttribute("width", "10.2");
      pixel.setAttribute("height", "10.2");
      $(".pixels").append(pixel);
      if (!reduced.matches) {
        void animate(
          pixel,
          [
            {
              // Pixels turn around their own centers inside a fixed character grid.
              // Moving their SVG origins made the whole cloud drift off-center.
              transform: `rotate(${(index % 4) * 90}deg) scale(0.15)`,
              opacity: 0,
            },
            { opacity: 0.9, offset: 0.24 },
            { transform: "rotate(0deg) scale(1)", opacity: 1 },
          ],
          { duration: timing.assemble, easing: easing.speedRamp },
        );
      }
      index++;
    }
  }
  async function enter() {
    if (reduced.matches) {
      settled = true;
      return;
    }
    void animate($(".identity"), [{ opacity: 0 }, { opacity: 1 }], {
      duration: timing.color,
      delay: 100,
    });
    // Crossfade the assembling pixels into one seamless gradient silhouette.
    // A single path avoids per-tile color patches and anti-aliased grid seams.
    void animate($(".pixels"), [{ opacity: 1 }, { opacity: 0 }], {
      duration: timing.color,
      delay: timing.assemble - 350,
    });
    void animate($(".body-shape"), [{ opacity: 0 }, { opacity: 1 }], {
      duration: timing.color,
      delay: timing.assemble - 350,
    });
    void animate($(".body-rim"), [{ opacity: 0 }, { opacity: 0.5 }], {
      duration: timing.color,
      delay: timing.assemble - 350,
    });
    void animate(
      $(".sheen"),
      [
        { opacity: 0, transform: "translateX(0)" },
        { opacity: 0.65, offset: 0.28 },
        { opacity: 0, transform: "translateX(330px)" },
      ],
      { duration: timing.scope + 220, delay: timing.assemble },
    );
    for (const [i, actor] of [$(".accent-orbit"), $(".satellites")].entries()) {
      void animate(
        actor,
        [
          { opacity: 0, transform: `rotate(${i ? -80 : 100}deg) scale(0.55)` },
          { opacity: i ? 0.8 : 0.5, offset: 0.3 },
          { opacity: 0, transform: `rotate(${i ? 460 : -420}deg) scale(1.18)` },
        ],
        { duration: timing.assemble + 320, easing: easing.speedRamp },
      );
    }
    for (const [i, comet] of [
      ...document.querySelectorAll(".comet"),
    ].entries()) {
      void animate(
        comet,
        [
          { opacity: 0, transform: `rotate(${i * 120 - 180}deg) scale(0.7)` },
          { opacity: 0.9, offset: 0.2 },
          { opacity: 0.65, offset: 0.7 },
          { opacity: 0, transform: `rotate(${i * 120 + 450}deg) scale(1.18)` },
        ],
        {
          duration: timing.assemble + 180,
          delay: i * 60,
          easing: easing.speedRamp,
        },
      );
    }
    void animate(
      $(".mascot"),
      [
        { transform: "rotate(-540deg) scale(0.35)" },
        { transform: "rotate(0deg) scale(1)" },
      ],
      { duration: timing.assemble + 300, easing: easing.speedRamp },
    );
    for (const [i, orbit] of [
      ...document.querySelectorAll(".orbit"),
    ].entries()) {
      void animate(
        orbit,
        [
          {
            transform: `rotate(${i * 90 - 90}deg) scaleY(0.35) scale(0.4)`,
            opacity: 0,
          },
          { opacity: 0.8, offset: 0.25 },
          {
            transform: `rotate(${i * 90 + 250}deg) scaleY(0.35) scale(1.35)`,
            opacity: 0,
          },
        ],
        { duration: timing.assemble, easing: easing.speedRamp },
      );
    }
    void animate($(".ground"), [{ opacity: 0 }, { opacity: 1 }], {
      duration: timing.color,
      delay: timing.assemble,
    });
    await animate(
      $(".eyes"),
      [
        { opacity: 0, transform: "scaleY(0.1)" },
        { opacity: 1, transform: "scaleY(1)" },
      ],
      { duration: timing.lock, delay: timing.assemble },
    );
    if (skipped) return;
    $(".identity p").textContent = "Bringing it all into focus";
    void animate(
      $(".scope"),
      [
        { opacity: 0, transform: "rotate(-35deg) scale(1.22)" },
        { opacity: 1, transform: "rotate(0deg) scale(1)" },
      ],
      { duration: timing.scope },
    );
    void animate(
      $(".scope-inner"),
      [{ strokeDashoffset: 835.7 }, { strokeDashoffset: 0 }],
      { duration: timing.scope },
    );
    await animate(
      $(".scope-outer"),
      [{ strokeDashoffset: 898.5 }, { strokeDashoffset: 0 }],
      { duration: timing.scope },
    );
    if (skipped) return;
    for (const corner of document.querySelectorAll(".lock-corner")) {
      void animate(
        corner,
        [
          { opacity: 0, scale: 1.4 },
          { opacity: 0.8, scale: 1 },
        ],
        { duration: timing.lock, easing: easing.settle },
      );
    }
    void animate(
      $(".lock-ripple"),
      [
        { opacity: 0, transform: "scale(0.94)" },
        { opacity: 0.6, offset: 0.12 },
        { opacity: 0, transform: "scale(1.5)" },
      ],
      { duration: timing.scope },
    );
    void animate(
      $(".echo-ripple"),
      [
        { opacity: 0, transform: "scale(0.88)" },
        { opacity: 0.5, offset: 0.16 },
        { opacity: 0, transform: "scale(1.85)" },
      ],
      { duration: timing.scope + 120, delay: 70 },
    );
    void animate(
      $(".starburst"),
      [
        { opacity: 0, transform: "scale(0.3) rotate(-15deg)" },
        { opacity: 0.55, offset: 0.25 },
        { opacity: 0, transform: "scale(1.7) rotate(15deg)" },
      ],
      { duration: timing.scope },
    );
    for (let i = 0; i < 24; i++) {
      const spark = document.createElement("span");
      spark.className = "spark";
      $(".sparks").append(spark);
      const angle = (i * Math.PI) / 12 + Math.PI / 24;
      const x = Math.cos(angle),
        y = Math.sin(angle);
      void animate(
        spark,
        [
          {
            opacity: 0,
            transform: `translate(${x * 136}px, ${y * 136}px) scale(0.5)`,
          },
          { opacity: 0.85, offset: 0.16 },
          {
            opacity: 0,
            transform: `translate(${x * (i % 2 ? 215 : 185)}px, ${y * (i % 2 ? 215 : 185)}px) scale(0.2) rotate(135deg)`,
          },
        ],
        { duration: timing.scope, delay: (i % 3) * 20 },
      );
    }
    await Promise.all([
      animate($(".scope-label"), [{ opacity: 0 }, { opacity: 1 }], {
        duration: timing.lock,
      }),
      animate(
        $(".mascot"),
        [
          { transform: "scale(1)" },
          { transform: "scale(1.025, 0.975)", offset: 0.2 },
          { transform: "scale(0.99, 1.01)", offset: 0.55 },
          { transform: "scale(1)" },
        ],
        { duration: timing.lock + 120 },
      ),
      animate(
        $(".eyes"),
        [
          { transform: "scaleY(1)" },
          { transform: "scaleY(0.15)", offset: 0.45 },
          { transform: "scaleY(1)" },
        ],
        { duration: timing.lock + 120 },
      ),
    ]);
    settled = true;
    document.body.classList.add("waiting");
  }
  function prepare() {
    if (preparing) return preparing;
    preparing = (async () => {
      await entrance;
      if (reduced.matches || skipped) return;
      await Promise.all([
        animate(
          $(".scope"),
          [
            { transform: "rotate(0deg) scale(1)" },
            { transform: "rotate(-8deg) scale(0.92)" },
          ],
          { duration: timing.anticipate },
        ),
        animate(
          $(".mascot"),
          [{ transform: "scale(1)" }, { transform: "scale(0.94)" }],
          { duration: timing.anticipate },
        ),
      ]);
    })();
    return preparing;
  }
  async function exit() {
    if (exiting) return exiting;
    exiting = (async () => {
      await prepare();
      if (!settled && !skipped) return;
      document.body.classList.remove("waiting");
      document.body.dataset.phase = "reveal";
      notify("vizor:intro-reveal");
      $(".identity p").textContent = "Your workspace, in focus";
      const fade = reduced.matches || skipped;
      const duration = fade ? timing.fade : timing.exit;
      void animate($(".identity"), [{ opacity: 1 }, { opacity: 0 }], {
        duration: fade ? timing.fade : timing.lock,
      });
      if (!fade) {
        void animate(
          $(".starburst"),
          [
            { opacity: 0, transform: "scale(0.5) rotate(0deg)" },
            { opacity: 0.5, offset: 0.18 },
            { opacity: 0, transform: "scale(3.4) rotate(35deg)" },
          ],
          { duration: timing.scope, easing: easing.reveal },
        );
        void animate(
          $(".mascot"),
          [
            {
              opacity: 1,
              transform: "scale(0.94) rotate(0deg)",
            },
            {
              opacity: 0,
              transform: "scale(0.2) rotate(24deg)",
            },
          ],
          { duration: timing.lock },
        );
        void animate(
          $(".scope"),
          [
            { opacity: 1, transform: "rotate(-8deg) scale(0.92)" },
            { opacity: 0, transform: "rotate(18deg) scale(8)" },
          ],
          { duration, easing: easing.reveal },
        );
        await animate(
          $(".lock-ripple"),
          [
            { opacity: 0.4, transform: "scale(0.92)" },
            { opacity: 0, transform: "scale(7)" },
          ],
          { duration, easing: easing.reveal },
        );
      } else {
        await Promise.all([
          animate($(".intro"), [{ opacity: 1 }, { opacity: 0 }], { duration }),
        ]);
      }
      document.body.dataset.complete = "true";
      notify("vizor:intro-complete");
    })();
    return exiting;
  }
  function skip() {
    skipped = true;
    for (const animation of animations) animation.finish();
    settled = true;
    $(".identity p").textContent = ready
      ? "Your workspace, in focus"
      : "Opening your workspace…";
    if (ready) void exit();
  }
  const entrance = enter();
  window.vizorIntro = {
    prepare,
    finish: () => {
      ready = true;
      return exit();
    },
  };
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") skip();
  });
  window.addEventListener("message", (event) => {
    if (
      event.source === window.parent &&
      event.origin === location.origin &&
      event.data?.type === "vizor:workspace-ready"
    )
      void window.vizorIntro.finish();
  });
  reduced.addEventListener("change", () => {
    if (reduced.matches) skip();
  });
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("paused", document.hidden);
    for (const animation of animations)
      document.hidden ? animation.pause() : animation.play();
  });
  notify("vizor:intro-mounted");
  if (new URLSearchParams(location.search).has("preview"))
    void window.vizorIntro.finish();
})();
