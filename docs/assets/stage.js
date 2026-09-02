/* DevNotes+ — the travelling stage.

   One VS Code window for the whole page. It is mounted once into a fixed
   layer and placed over whichever .stage-slot currently owns it: the hero,
   the feature column, the Claude Code panel. Sections therefore hand the
   window to each other rather than each drawing their own copy of it, which
   is what makes it the page's one continuous object.

   Size
   ────
   The window is laid out at the width of the slot it is resting in, at scale
   1 — so its type is the size the mock was authored at, never a shrunken
   copy of it. Only a move between slots is scaled: the transform carries it
   across (cheap, smooth, no reflow per frame), and when it lands the width is
   baked in and the transform returns to 1. Because the scaled size at the end
   of the move equals the baked size, the swap is invisible.

   Placement
   ─────────
   • Scroll following is 1:1 and instant: the slot's screen rect is the
     target, so the window tracks the page exactly.
   • --stage-pin holds it in place while its section scrolls past, bounded by
     data-stage-pin-box. That is the stage's own maths rather than CSS sticky,
     which cannot be read back in the same frame as a programmatic scroll.
   • A handoff is a cut: the next slot takes the window where it is and the
     scroll following carries it on. Only a layout change under a parked
     window — the hero copy opening after the intro — is eased, over TWEEN
     ms. That is the one animated move left.

   Placement is applied synchronously and then from scroll and resize events.
   Tweens run on an interval rather than requestAnimationFrame: a suspended
   frame callback must never leave the window somewhere the page did not put
   it.

   Requires assets/mock-scenes.js. */
(function (global) {
  'use strict';

  var TWEEN = 780;   // handoff and dock duration, ms
  var SCALE = 0.7;   // the resize is done this far through the move, so the
                     // last stretch is a glide at the landing size
  var JUMP  = 24;    // px of unexplained target movement that earns a tween
  var TICK  = 16;    // tween ticker

  var REDUCED = global.matchMedia
    ? global.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  /* Out quint: the window leaves fast and spends most of the move
     decelerating, so it settles into the slot rather than stopping in it. */
  function ease(t) { return 1 - Math.pow(1 - t, 5); }

  function Stage(layer, flight, slots) {
    this.layer  = layer;
    this.flight = flight;
    this.slots  = slots;
    this.baked  = null;    // the slot the window is currently laid out for
    this.bakedW = 0;
    this.bakedH = 0;
    this.active = null;
    this.cur    = null;
    this.tween  = null;
    this.timer  = 0;
    this.lastY  = global.scrollY;
    this.onSlot = null;
    this.scene  = null;
    this._sync  = this.sync.bind(this);
  }

  /* A slot's stage metrics come from CSS custom properties on the slot, so
     what each breakpoint wants stays in the stylesheet with the rest of the
     layout:

       --stage-vpad   viewport height to leave around the window; the mock's
                      body height is clamped against it
       --stage-pin    distance from the top of the viewport to hold at
                      (0 = not pinned; it travels with its slot) */
  Stage.prototype.metrics = function (slot) {
    var cs = getComputedStyle(slot);
    slot.__stage = {
      vpad: parseFloat(cs.getPropertyValue('--stage-vpad')) || 0,
      pin: parseFloat(cs.getPropertyValue('--stage-pin')) || 0,
    };
    return slot.__stage;
  };

  Stage.prototype.metricsOf = function (slot) {
    return slot.__stage || this.metrics(slot);
  };

  Stage.prototype.widthFor = function (slot) {
    return Math.round(slot.getBoundingClientRect().width);
  };

  /* Lay the window out for a slot: its width, and the body height clamp that
     slot asks for. */
  Stage.prototype.bake = function (slot) {
    var m = this.metricsOf(slot);
    this.flight.style.width = this.widthFor(slot) + 'px';
    this.flight.style.setProperty('--stage-vpad', m.vpad + 'px');
    this.baked = slot;
    this.bakedW = this.flight.offsetWidth;
    this.bakedH = this.flight.offsetHeight;
    return this;
  };

  /* Every slot reserves exactly the room the window will take there, which
     means baking for each one in turn and reading it back.

     A slot with no width is not a small slot — it is a slot that is not laid
     out yet: the layer is still display:none under the narrow breakpoint, or
     the frame has not been sized. Measuring then would bake zero into every
     reservation and there would be nothing left to recover from, so a zero is
     refused and the stage stays un-measured until the geometry is real. */
  Stage.prototype.measure = function () {
    var self = this;
    var live = this.slots.filter(function (s) {
      return s.getBoundingClientRect().width > 0;
    });
    if (!live.length) { this.ready = false; return this; }

    var keep = this.flight.style.transform;
    this.flight.style.transform = 'none';
    live.forEach(function (slot) {
      self.metrics(slot);
      self.bake(slot);
      slot.__stage.h = self.bakedH;
      slot.style.height = self.bakedH + 'px';
    });
    if (this.active) { this.bake(this.active); }
    this.flight.style.transform = keep;
    this.ready = this.bakedW > 0;
    if (this.onGeometry) { this.onGeometry(this); }
    return this;
  };

  /* The furthest-scrolled slot the page has reached. Slots are in document
     order, so this is a handoff and never a competition.

     The line is low in the viewport on purpose: the next slot claims the
     window while the current one is still on screen, so the move between
     sections is a travel the visitor watches rather than a cut. */
  Stage.prototype.pick = function () {
    var mid = global.innerHeight * 0.85;
    var best = this.slots[0];
    this.slots.forEach(function (s) {
      if (s.getBoundingClientRect().top <= mid) { best = s; }
    });
    return best;
  };

  Stage.prototype.targetFor = function (slot) {
    var r = slot.getBoundingClientRect();
    var m = this.metricsOf(slot);
    var w = this.widthFor(slot);
    var h = m.h || this.bakedH;
    var y = r.top;
    var box = slot.dataset.stagePinBox
      && document.querySelector(slot.dataset.stagePinBox);
    /* Pinning off the slot's own top rather than the box's: the window rides
       its slot up the page, holds at --stage-pin the moment it gets there,
       and is let go when the box runs out under it. Because the hold begins
       exactly where the window already was, the pin costs no jump — which is
       what lets one slot carry the window across two sections instead of
       handing it to a second one somewhere else on the page. The box now
       supplies only the release point. */
    if (m.pin && box) {
      var b = box.getBoundingClientRect();
      y = Math.min(Math.max(m.pin, y), b.bottom - h);
    }
    return { x: r.left + (r.width - w) / 2, y: y, w: w, h: h };
  };

  /* Where the window is actually drawn, in viewport coordinates. */
  Stage.prototype.rect = function () {
    var c = this.cur || { x: 0, y: 0, s: 1 };
    return {
      left: c.x,
      top: c.y,
      right: c.x + this.bakedW * c.s,
      bottom: c.y + this.bakedH * c.s,
    };
  };

  Stage.prototype.start = function () {
    addEventListener('scroll', this._sync, { passive: true });
    addEventListener('resize', this._sync, { passive: true });
    this.sync();

    var self = this;
    var remeasure = function () { self.measure().sync(); };

    /* Recovery is driven by the stage's own readiness, not by a change in
       the geometry. The failure this guards against is "the measurement ran
       before the layout was real", and in that case the geometry never
       changes again — it was already correct by the time anything could
       observe it. So: while the stage is not ready, every signal that layout
       has run is a reason to measure again; once it is ready, only a genuine
       size change is.

       A slot's own box is what is watched, because a resize event does not
       fire for a frame that reached its final size before load and a
       media-query change does not fire for a crossing that already happened. */
    var last = -1;
    var retry = function () {
      if (!self.ready) { remeasure(); return; }
      var w = self.slots[0].getBoundingClientRect().width;
      if (w !== last) { last = w; remeasure(); }
    };

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(retry).observe(this.slots[0]);
    } else {
      setTimeout(retry, 120);
      setTimeout(retry, 600);
    }
    addEventListener('load', retry);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(retry);
    }
    return this;
  };

  Stage.prototype.sync = function () {
    var y = global.scrollY;
    var scrolled = y !== this.lastY;

    var next = this.pick();
    if (next !== this.active) {
      var was = this.active;
      this.active = next;
      // Handed over, not flown over. The teaser has already said the window
      // is moving to the features folder, and animating the move as well
      // says it twice — so the new slot simply takes it and the 1:1 scroll
      // following carries it from there.
      this.bake(next);
      if (this.onSlot) { this.onSlot(next, was); }
    }

    var to = this.targetFor(this.active);

    // A target that moved on its own — the hero copy opening under a parked
    // window, a resize — is a move worth animating. One that moved because
    // the page scrolled is not.
    if (!this.tween && this.cur && !scrolled
        && (Math.abs(to.y - this.cur.y) > JUMP || Math.abs(to.x - this.cur.x) > JUMP)) {
      this.begin();
    }

    var out;
    if (this.tween) {
      var p = (Date.now() - this.tween.t0) / TWEEN;
      if (p >= 1) {
        this.tween = null;
        this.flight.style.willChange = 'auto';
        this.bake(this.active);            // land at native size
        out = { x: to.x, y: to.y, s: 1 };
      } else {
        var k = ease(p);
        var ks = ease(Math.min(1, p / SCALE));
        var f = this.tween.from;
        var fy = f.y - (y - this.tween.y0);   // keep the start point on the page
        // The window is still laid out for the slot it left, so the size
        // difference is carried by the transform.
        var ts = this.bakedW ? to.w / this.bakedW : 1;
        out = {
          x: f.x + (to.x - f.x) * k,
          y: fy + (to.y - fy) * k,
          s: f.s + (ts - f.s) * ks,
        };
      }
    } else {
      if (this.baked !== this.active || this.bakedW !== to.w) { this.bake(this.active); }
      out = { x: to.x, y: to.y, s: 1 };
    }

    this.cur = out;
    this.flight.style.transform =
      'translate3d(' + out.x.toFixed(1) + 'px,' + out.y.toFixed(1) + 'px,0)'
      + (out.s === 1 ? '' : ' scale(' + out.s.toFixed(4) + ')');

    // Judged on where the window actually is, not on where its slot is: a
    // pinned window outlives its slot's own trip up the viewport.
    var h = this.bakedH * out.s;
    this.layer.classList.toggle('is-off',
      !(out.y + h > -60 && out.y < global.innerHeight + 60));

    this.lastY = y;
    if (this.tween) { this.pump(); }
  };

  /* will-change is set only for the duration of a move. Left on, Chrome keeps
     the layer rasterised at one scale and the window stays soft; taken off, it
     re-rasters at the size it is actually drawn at. */
  Stage.prototype.begin = function () {
    if (REDUCED.matches) { return; }
    this.tween = { from: this.cur, t0: Date.now(), y0: global.scrollY };
    this.flight.style.willChange = 'transform';
    this.pump();
  };

  /* Keep in step with a layout that is still settling — the hero copy coming
     back, a section changing height. */
  Stage.prototype.follow = function (ms) {
    var self = this;
    var t = setInterval(this._sync, 32);
    setTimeout(function () { clearInterval(t); self.sync(); }, ms || 1200);
    return this;
  };

  Stage.prototype.pump = function () {
    if (this.timer) { return; }
    var self = this;
    this.timer = setInterval(function () {
      if (!self.tween) { clearInterval(self.timer); self.timer = 0; return; }
      self.sync();
    }, TICK);
  };

  /* Point the window at another scene. Scenes play once and hold: a demo
     looping under a paragraph someone is reading pulls the eye back for
     nothing. */
  Stage.prototype.play = function (id, onEnd) {
    var def = global.MockScenes.registry[id];
    if (!def || !this.scene) { return this; }
    this.scene.setDef(def);
    if (REDUCED.matches) {
      this.scene.seek(this.scene.duration());
      if (onEnd) { onEnd(); }
      return this;
    }
    this.scene.play();
    if (onEnd) {
      clearTimeout(this._endTimer);
      this._endTimer = setTimeout(onEnd, this.scene.duration());
    }
    return this;
  };

  /* mount() puts one mock in the fixed layer and hands back a live stage.
     opts.first is the scene it opens on. */
  function mount(opts) {
    var layer  = opts.layer;
    var flight = opts.flight;
    var slots  = Array.prototype.slice.call(opts.slots);
    if (!layer || !flight || !slots.length || !global.MockScenes) {
      return Promise.reject(new Error('stage: nothing to mount'));
    }
    return global.MockScenes.stage(flight, opts.first).then(function (scene) {
      Object.keys(global.MockScenes.registry).forEach(function (id) {
        global.MockScenes.registry[id].loop = false;
      });
      var stage = new Stage(layer, flight, slots);
      stage.scene = scene;
      stage.onGeometry = opts.onGeometry || null;
      stage.measure();
      stage.start();
      layer.classList.add('is-live');
      addEventListener('resize', function () { stage.measure(); }, { passive: true });
      return stage;
    });
  }

  global.MockStage = { mount: mount };
})(window);
