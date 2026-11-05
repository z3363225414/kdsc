// EP03 动作系统：按原版的规则逐步模拟玩家，镜头、手、方块、别的玩家都从模拟结果里取。
// 为什么：EP02 的镜头是手摆的关键帧插值，方块按固定节拍“弹”出来，走路晃动和脚步不同步，别人走路是匀速滑步——看着僵硬。
// 这里不摆关键帧，只写“玩家想做什么”（走到哪、看哪、搭几格、跳），控制器自己按原版的手感算出怎么动。
//
// 原版的参数（1 tick = 0.05 秒）：
//   地面上每 tick 速度 × 0.546（摩擦 0.6 × 0.91）再加输入 → 换成连续时间：速度按 k = 12.1/秒 指数逼近目标速度（约 5 tick 到 95%）。
//   走 4.317 格/秒，疾跑 5.612，潜行 1.295；起跳初速 0.42 格/tick，下落每 tick vy = (vy − 0.08) × 0.98。
//   视角晃动（GameRenderer.bobView）：按走过的距离走相位，左右、上下、侧倾、俯仰；晃动幅度每 tick 向 min(0.1, 速度) 靠 40%。
//   手：挥一次 6 tick；换物品时手先放下再抬起；转视角时手稍微落后一点（renderArmYaw，每 tick 追 50%）。
//   别人的腿：limbSwingAmount 每 tick 向 min(1, 位移 × 4) 靠 40%，limbSwing += 摆幅；腿转角 cos(limbSwing × 0.6662) × 1.4 × 摆幅。
//   身体朝向跟着移动方向，头比身体先转（头和身体的夹角最多 75°）。
//
// 模拟以 120 Hz 积分，从 0 秒一直算到片尾，结果缓存成数组；sample(t) 在相邻两个样本之间插值。renderAt(t) 仍是纯函数。

export const HZ = 120, DT = 1 / HZ;
const K_GROUND = -Math.log(0.546) / 0.05;         // 12.1 /s
const K_AIR = -Math.log(0.91) / 0.05 * 0.55;      // 空中几乎保持原来的水平速度，只能小幅改方向
const SPEED = { walk: 4.317, sprint: 5.612, sneak: 1.295, stop: 0 };
const G = 28, DRAG = 0.4, JUMP_V = 8.4;            // 跳 1.25 格高，空中约 0.6 秒
const EYE = 1.62, EYE_SNEAK = 1.27;
const HALF = 0.3;                                   // 碰撞箱半宽（0.6 格宽）
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
export const yawTo = (x, z, tx, tz) => Math.atan2(tx - x, -(tz - z));   // 0 朝北（−z），正数往东（+x）转
export const pitchTo = (x, y, z, tx, ty, tz) => Math.atan2(ty - y, Math.hypot(tx - x, tz - z));

// 二阶弹簧：带一点点过冲（ζ < 1）、角速度有上限——人拿鼠标转头的样子
function spring(s, target, w, zeta, vmax, dt) {
  const a = w * w * (target - s.x) - 2 * zeta * w * s.v;
  s.v += a * dt;
  if (Math.abs(s.v) > vmax) s.v = Math.sign(s.v) * vmax;
  s.x += s.v * dt;
}

// world：{ solid(x, y, z) → bool }（整数格子），由场景提供；放下的方块由模拟自己记着
export class Sim {
  constructor(world, duration) {
    this.world = world; this.duration = duration;
    this.agents = []; this.placed = new Map(); this.events = [];
  }
  solid(x, y, z) { return this.placed.has(`${x},${y},${z}`) || this.world.solid(x, y, z); }
  // 碰撞箱 [x±0.3, y..y+h, z±0.3] 有没有碰到方块
  hits(x, y, z, h = 1.8) {
    for (let bx = Math.floor(x - HALF + 1e-4); bx <= Math.floor(x + HALF - 1e-4); bx++)
      for (let bz = Math.floor(z - HALF + 1e-4); bz <= Math.floor(z + HALF - 1e-4); bz++)
        for (let by = Math.floor(y + 1e-4); by <= Math.floor(y + h - 1e-4); by++) if (this.solid(bx, by, bz)) return true;
    return false;
  }
  // 脚下有没有方块托着（碰撞箱的四个角任意一个踩在方块上就算）
  grounded(x, y, z) {
    const by = Math.floor(y - 0.02);
    if (Math.abs(y - (by + 1)) > 0.03) return false;
    for (let bx = Math.floor(x - HALF + 1e-4); bx <= Math.floor(x + HALF - 1e-4); bx++)
      for (let bz = Math.floor(z - HALF + 1e-4); bz <= Math.floor(z + HALF - 1e-4); bz++) if (this.solid(bx, by, bz)) return true;
    return false;
  }
  add(o) { const a = new Agent(this, o); this.agents.push(a); return a; }
  run() {
    const n = Math.ceil(this.duration * HZ) + 2;
    for (const a of this.agents) a.begin(n);
    for (let i = 0; i < n; i++) {
      const t = i * DT;
      for (const a of this.agents) a.step(t);
      for (const a of this.agents) a.record(i);
    }
    this.events.sort((a, b) => a.t - b.t);
    return this;
  }
  // 某一时刻放好了的方块
  blocksAt(t) { return this.events.filter(e => e.kind === 'place' && e.t <= t); }
}

// 一个玩家：任务队列（走、搭路、垫高、等）+ 视线脚本 + 挥手
export class Agent {
  constructor(sim, o) {
    this.sim = sim; this.name = o.name || 'p';
    this.x = o.pos[0]; this.y = o.pos[1]; this.z = o.pos[2];
    this.vx = 0; this.vy = 0; this.vz = 0; this.ground = true;
    this.tasks = []; this.looks = []; this.swings = []; this.items = []; this.kicks = []; this.deadAt = Infinity; this.prevT = -1;
    this.yaw = { x: o.yaw || 0, v: 0 }; this.pitch = { x: o.pitch || 0, v: 0 };
    this.bob = 0; this.walked = 0; this.limb = 0; this.limbAmt = 0; this.bodyYaw = o.yaw || 0;
    this.eye = EYE; this.sneak = false; this.armYaw = this.yaw.x; this.armPitch = this.pitch.x;
    this.lastDir = o.yaw || 0; this.frozen = o.frozen || null;
    this.cur = null; this.lookCur = null; this.inputX = 0; this.inputZ = 0; this.gait = 'stop'; this.wantJump = false;
  }
  // ---- 脚本
  // do(t, task)：从 t 开始做这件事（前一件没做完就排在后面）
  // 任务按写的先后顺序一件件做：前一件做完、而且到了 t（最早开始的时间）才开始下一件
  do(t, task) { this.tasks.push({ t, ...task }); return this; }
  goto(t, pts, gait = 'walk', o = {}) { return this.do(t, { kind: 'goto', pts: pts.map(p => [...p]), gait, ...o }); }
  bridge(t, dir, n, o = {}) { return this.do(t, { kind: 'bridge', dir, n, ...o }); }
  pillar(t, n, o = {}) { return this.do(t, { kind: 'pillar', n, ...o }); }
  jump(t) { return this.do(t, { kind: 'jump' }); }
  // look(t, spec)：从 t 起视线这么走。spec: { path: pitch }（看着前进方向）| { at: [x,y,z] 或 agent } | { yaw, pitch }
  //   w：转头快慢（自然频率，默认 9），vmax：最快角速度（默认 3.4 弧度/秒 ≈ 195°/秒）
  look(t, spec) { this.looks.push({ t, w: 9, zeta: 0.82, vmax: 2.9, ...spec }); this.looks.sort((a, b) => a.t - b.t); return this; }
  swing(t, kind = 'attack') { this.swings.push({ t, kind }); this.swings.sort((a, b) => a.t - b.t); return this; }
  hold(t, item) { this.items.push({ t, item }); this.items.sort((a, b) => a.t - b.t); return this; }
  // 被打中：t 时刻从 from（另一个玩家）的方向被击退（原版：水平约 0.4 格/tick，向上 0.36 格/tick 的一个小跳）
  hurtBy(t, from, o = {}) { this.kicks.push({ t, from, power: o.power ?? 7.2, up: o.up ?? 6.4 }); this.kicks.sort((a, b) => a.t - b.t); return this; }
  die(t) { this.deadAt = t; return this; }
  // 追着另一个玩家：保持在 dist 格左右，一边绕着走（PvP 里的左右横移）；到 until 为止
  chase(t, target, o = {}) { return this.do(t, { kind: 'chase', target, dist: o.dist ?? 2.4, until: o.until ?? Infinity, gait: o.gait || 'sprint', strafe: o.strafe ?? 0.55, ...o }); }
  teleport(t, pos, yaw = null) { return this.do(t, { kind: 'teleport', pos, yaw }); }
  // 到了时间（而且前面的事做完了）就做一个动作：右键 / 左键一下，记一个事件（场景按事件的真实时间画开箱等），再站 dur 秒
  act(t, name, o = {}) { return this.do(t, { kind: 'act', name, dur: o.dur ?? 0.5, swing: o.swing ?? 'use', ...o }); }
  wait(t, until) { return this.do(t, { kind: 'wait', until }); }
  // 事件的真实时间（没发生过就是 Infinity）
  when(name) { const e = this.sim.events.find(e => e.who === this.name && e.kind === name); return e ? e.t : Infinity; }

  // ---- 模拟
  begin(n) {
    const F = () => new Float32Array(n);
    this.rec = { x: F(), y: F(), z: F(), yaw: F(), pitch: F(), bob: F(), walked: F(), limb: F(), limbAmt: F(), body: F(), eye: F(), armYaw: F(), armPitch: F(), vx: F(), vz: F(), ground: F() };
  }
  record(i) {
    const r = this.rec;
    r.x[i] = this.x; r.y[i] = this.y; r.z[i] = this.z; r.yaw[i] = this.yaw.x; r.pitch[i] = this.pitch.x;
    r.bob[i] = this.bob; r.walked[i] = this.walked; r.limb[i] = this.limb; r.limbAmt[i] = this.limbAmt; r.body[i] = this.bodyYaw;
    r.eye[i] = this.eye; r.armYaw[i] = this.armYaw; r.armPitch[i] = this.armPitch; r.vx[i] = this.vx; r.vz[i] = this.vz; r.ground[i] = this.ground ? 1 : 0;
  }
  place(t, bx, by, bz, block = 'planks') {
    const key = `${bx},${by},${bz}`;
    if (this.sim.solid(bx, by, bz)) return false;
    this.sim.placed.set(key, block);
    this.sim.events.push({ t, kind: 'place', x: bx, y: by, z: bz, block, who: this.name });
    this.swings.push({ t, kind: 'use' });
    return true;
  }
  // 当前任务：决定输入方向、步态、要不要跳、要不要放方块
  think(t) {
    this.inputX = 0; this.inputZ = 0; this.wantJump = false; this.sneak = false;
    if (!this.cur || this.cur.done) {
      let nx = this.tasks.find(k => !k.started);
      if (nx && nx.t > t) nx = null;
      if (nx) {
        nx.started = true; this.cur = nx; nx.t0 = t;
        // 任务自带的视线：开始做这件事的那一刻才转头（不会提前转身、倒着跑）
        const auto = nx.kind === 'bridge' ? { yaw: Math.atan2(-nx.dir[0], nx.dir[1]), pitch: -1.36, w: 5, vmax: 2.2 } : nx.kind === 'pillar' ? { pitch: -1.5, w: 8 } : null;
        const lk = nx.look === undefined ? auto : nx.look;
        if (lk) { this.look(t, lk); nx.lookSpec = lk; }
        // 任务自带的“切换物品”：开始做这件事时换到手上（例如搭路前换木板）
        if (nx.hold !== undefined) { this.items.push({ t, item: nx.hold }); this.items.sort((p, q) => p.t - q.t); }
      }
    }
    const k = this.cur;
    if (!k || k.done) { this.gait = 'stop'; return; }
    if (k.kind === 'jump') { this.wantJump = true; k.done = true; this.gait = 'stop'; return; }
    if (k.kind === 'act') {
      this.gait = 'stop';
      if (!k.fired) { k.fired = t; if (k.swing) this.swings.push({ t, kind: k.swing }); this.sim.events.push({ t, kind: k.name, who: this.name }); }
      if (t - k.fired >= k.dur) k.done = true;
      return;
    }
    if (k.kind === 'wait') { this.gait = 'stop'; if (t >= k.until) k.done = true; return; }
    if (k.kind === 'teleport') {
      [this.x, this.y, this.z] = k.pos; this.vx = this.vy = this.vz = 0; this.ground = true;
      if (k.yaw !== null) { this.yaw.x = k.yaw; this.yaw.v = 0; this.bodyYaw = k.yaw; this.armYaw = k.yaw; }
      k.done = true; this.gait = 'stop'; return;
    }
    if (k.kind === 'chase') {
      if (t >= k.until || k.target.deadAt <= t) { k.done = true; this.gait = 'stop'; return; }
      const dx = k.target.x - this.x, dz = k.target.z - this.z, d = Math.hypot(dx, dz) || 1;
      const ux = dx / d, uz = dz / d;
      // 离得远就冲过去；近了就前后保持距离、左右横移（方向慢慢换，不抖）
      const fwd = Math.max(-1, Math.min(1, (d - k.dist) * 1.2));
      const side = k.strafe * Math.sin((t - k.t0) * 2.1 + (k.phase || 0));
      this.inputX = ux * fwd - uz * side; this.inputZ = uz * fwd + ux * side;
      const m = Math.hypot(this.inputX, this.inputZ); if (m > 1) { this.inputX /= m; this.inputZ /= m; }
      this.gait = d > k.dist + 1.5 ? k.gait : 'walk';
      return;
    }
    if (k.kind === 'goto') {
      this.gait = k.gait;
      // 沿折线走：先算出自己投影在路线上走到了哪（弧长 s），朝 s + 1.4 格的点走，眼睛看 s + 3.5 格的点。
      // 目标点沿路线连续移动，所以拐弯是圆的、视线也是连续转过去的（不会到一个拐点就突然转向）。
      if (!k.poly) k.poly = new Poly([[this.x, this.z], ...k.pts]);
      const P = k.poly, sp = P.project(this.x, this.z, k.sp || 0);
      k.sp = sp;
      const left = P.len - sp, stopD = SPEED[k.gait] / K_GROUND + 0.05;   // 松开 W 以后还会滑这么远
      const [ex, ez] = P.at(P.len);
      if (left < stopD && Math.hypot(ex - this.x, ez - this.z) < stopD + 0.3) { k.done = true; this.gait = 'stop'; return; }
      const [tx, tz] = P.at(Math.min(P.len, sp + 1.4));
      const d = Math.hypot(tx - this.x, tz - this.z) || 1;
      this.inputX = (tx - this.x) / d; this.inputZ = (tz - this.z) / d;
      this.gaze = P.at(Math.min(P.len + 2, sp + 3.5), true);
      this.sneak = k.gait === 'sneak';
      return;
    }
    if (k.kind === 'bridge') {
      // 蹲着往后退着搭：脸朝搭路的反方向，脚后跟退到方块边上就右键放一块
      const [dx, dz] = k.dir;
      this.sneak = true; this.gait = 'sneak';
      if (k.placedN === undefined) { k.placedN = 0; k.wait = 0; }
      // 先转过身、低头，再开始往后退
      if (!k.turned) {
        const L = k.lookSpec;
        const ey = Math.abs(wrap(L.yaw - this.yaw.x)), ep = Math.abs((L.pitch ?? this.pitch.x) - this.pitch.x);
        this.gait = 'stop'; this.inputX = this.inputZ = 0;
        if (ey < 0.12 && ep < 0.12) k.turned = true; else return;
        this.gait = 'sneak';
      }
      // 放够了：退到对面的地上（离最后一块再退 1 格多）就停
      if (k.placedN >= k.n) {
        const past = (this.x - k.last[0]) * dx + (this.z - k.last[1]) * dz;
        if (past > 1.15) { if (!k.settle) k.settle = t; if (t - k.settle > 0.2) k.done = true; this.gait = 'stop'; return; }
        this.inputX = dx; this.inputZ = dz; return;
      }
      const fy = Math.round(this.y) - 1;
      // 脚下这一格往搭路方向的下一格
      const cx = Math.floor(this.x + dx * (HALF + 0.05)), cz = Math.floor(this.z + dz * (HALF + 0.05));
      const edge = !this.sim.solid(cx, fy, cz);
      if (edge && this.ground) {
        // 退到边上了：停一下（反应时间），放方块
        if (!k.wait) k.wait = t + (k.react ?? 0.07);
        if (t >= k.wait) { if (this.place(t, cx, fy, cz, k.block)) { k.placedN++; k.last = [cx + 0.5, cz + 0.5]; } k.wait = 0; }
      }
      // 一直往后退（潜行不会掉下去）
      this.inputX = dx; this.inputZ = dz;
      return;
    }
    if (k.kind === 'pillar') {
      // 原地垫高：跳起来，到最高点附近往脚下放一块
      if (k.placedN === undefined) { k.placedN = 0; k.phase = 'jump'; k.col = [Math.floor(this.x), Math.floor(this.z)]; }
      // 一直站在同一列的正中（慢慢挪回中心）
      const ox = k.col[0] + 0.5 - this.x, oz = k.col[1] + 0.5 - this.z;
      this.inputX = Math.max(-1, Math.min(1, ox * 2.5)); this.inputZ = Math.max(-1, Math.min(1, oz * 2.5));
      const centered = Math.hypot(ox, oz) < 0.12 && Math.hypot(this.vx, this.vz) < 0.35;
      if (k.placedN >= k.n) { if (!k.settle) k.settle = t; if (t - k.settle > 0.3) k.done = true; this.gait = 'walk'; return; }
      this.gait = 'walk';
      if (k.phase === 'jump' && this.ground && centered) { this.wantJump = true; k.phase = 'air'; k.y0 = Math.round(this.y); }
      else if (k.phase === 'air' && this.vy < 1.2 && this.y > k.y0 + 1.02) {
        if (this.place(t, k.col[0], k.y0, k.col[1], k.block)) k.placedN++;
        k.phase = 'land';
      } else if (k.phase === 'land' && this.ground) { k.phase = 'jump'; k.rest = t; }
      if (k.phase === 'jump' && k.rest && t - k.rest < (k.gap ?? 0.12)) this.wantJump = false;
    }
  }
  step(t) {
    if (this.frozen) { const f = this.frozen(t); if (f) { Object.assign(this, f); this.vx = this.vz = this.vy = 0; this.lookStep(t); return; } }
    const dead = t >= this.deadAt;
    if (dead) { this.cur = null; this.tasks = []; this.inputX = this.inputZ = 0; this.gait = 'stop'; this.wantJump = false; this.sneak = false; }
    else this.think(t);
    const S = this.sim;
    // 被打中的那一刻：击退（方向从打人的那个人指向自己）
    for (const kk of this.kicks) if (kk.t > this.prevT && kk.t <= t) {
      const fx = this.x - kk.from.x, fz = this.z - kk.from.z, d = Math.hypot(fx, fz) || 1;
      this.vx = this.vx * 0.5 + fx / d * kk.power; this.vz = this.vz * 0.5 + fz / d * kk.power; this.vy = kk.up; this.ground = false;
    }
    this.prevT = t;
    // 水平：速度指数逼近“输入方向 × 步态速度”
    const vmax = SPEED[this.gait] || 0;
    const kk = this.ground ? K_GROUND : K_AIR;
    const tx = this.inputX * vmax, tz = this.inputZ * vmax;
    const e = Math.exp(-kk * DT);
    this.vx = tx + (this.vx - tx) * e; this.vz = tz + (this.vz - tz) * e;
    // 自动起跳：前面是一格高的台阶、上面是空的
    if (this.ground && (Math.abs(this.vx) + Math.abs(this.vz)) > 0.5 && !this.sneak) {
      const sp = Math.hypot(this.vx, this.vz), fx = this.x + this.vx / sp * (HALF + 0.25), fz = this.z + this.vz / sp * (HALF + 0.25);
      const by = Math.floor(this.y + 0.01);
      if (S.solid(Math.floor(fx), by, Math.floor(fz)) && !S.solid(Math.floor(fx), by + 1, Math.floor(fz)) && !S.solid(Math.floor(fx), by + 2, Math.floor(fz))) this.wantJump = true;
    }
    if (this.wantJump && this.ground) { this.vy = JUMP_V; this.ground = false; if (this.gait === 'sprint') { const sp = Math.hypot(this.vx, this.vz) || 1; this.vx += this.vx / sp * 0.6; this.vz += this.vz / sp * 0.6; } }
    // 竖直
    if (!this.ground) { this.vy += (-G - DRAG * this.vy) * DT; }
    // 分轴移动 + 碰撞；潜行时不往没有方块托着的地方走（原版的“蹲着不掉下去”）
    const nx = this.x + this.vx * DT;
    if (!S.hits(nx, this.y, this.z) && !(this.sneak && this.ground && !S.grounded(nx, this.y, this.z))) this.x = nx; else this.vx = 0;
    const nz = this.z + this.vz * DT;
    if (!S.hits(this.x, this.y, nz) && !(this.sneak && this.ground && !S.grounded(this.x, this.y, nz))) this.z = nz; else this.vz = 0;
    const ny = this.y + this.vy * DT;
    if (this.vy <= 0 && S.hits(this.x, ny, this.z)) {
      // 落地：站到方块顶上
      this.y = Math.floor(ny) + 1; this.vy = 0; this.ground = true;
    } else if (this.vy > 0 && S.hits(this.x, ny, this.z)) { this.vy = 0; }
    else { this.y = ny; this.ground = S.grounded(this.x, this.y, this.z); if (this.ground) { this.y = Math.round(this.y); this.vy = 0; } else if (this.vy === 0) this.vy = -0.01; }
    // 放的方块正好在脚下（垫高）：被顶上去
    if (S.hits(this.x, this.y, this.z, 0.5)) { this.y = Math.floor(this.y) + 1; this.vy = Math.max(0, this.vy); }
    // 视角晃动、走过的距离、腿的摆幅
    const hs = Math.hypot(this.vx, this.vz);
    const perTick = hs * 0.05;
    const bobT = this.ground ? Math.min(0.1, perTick) : 0;
    this.bob += (bobT - this.bob) * (1 - Math.pow(0.6, DT / 0.05));
    if (this.ground) this.walked += hs * DT * 0.6;
    this.limbAmt += (Math.min(1, perTick * 4) - this.limbAmt) * (1 - Math.pow(0.6, DT / 0.05));
    this.limb += this.limbAmt * DT / 0.05;
    // 蹲下：眼睛降低
    this.eye += ((this.sneak ? EYE_SNEAK : EYE) - this.eye) * (1 - Math.pow(0.5, DT / 0.05));
    if (hs > 0.4) this.lastDir = Math.atan2(this.vx, -this.vz);
    this.lookStep(t);
    // 身体：走动时朝移动方向转；站着时头转过 50° 身体才跟上（每 tick 追 30%）
    const head = this.yaw.x;
    let target = hs > 0.4 ? this.lastDir : this.bodyYaw;
    if (hs > 0.4 && Math.abs(wrap(target - head)) > Math.PI / 2) target = wrap(target + Math.PI); // 往后退：身体还是朝着脸的方向
    let off = wrap(head - this.bodyYaw);
    if (hs <= 0.4 && Math.abs(off) > 0.87) target = head - Math.sign(off) * 0.87;
    this.bodyYaw += wrap(target - this.bodyYaw) * (1 - Math.pow(0.7, DT / 0.05));
    off = wrap(head - this.bodyYaw);
    if (Math.abs(off) > 1.31) this.bodyYaw = head - Math.sign(off) * 1.31;
    // 手跟着视角稍微落后
    this.armYaw += (this.yaw.x - this.armYaw) * (1 - Math.pow(0.5, DT / 0.05));
    this.armPitch += (this.pitch.x - this.armPitch) * (1 - Math.pow(0.5, DT / 0.05));
  }
  lookStep(t) {
    let L = null;
    for (const l of this.looks) if (l.t <= t) L = l;
    if (!L) return;
    let ty = this.yaw.x, tp = this.pitch.x;
    const ex = this.x, ey = this.y + this.eye, ez = this.z;
    if (L.path !== undefined) {
      // 看着路线前方 3.5 格的点（没在走路时保持原来的方向）
      const moving = this.cur && this.cur.kind === 'goto' && !this.cur.done && this.gaze;
      if (moving) ty = yawTo(this.x, this.z, this.gaze[0], this.gaze[1]) + (L.yawOff || 0);
      tp = L.path;
    } else if (L.at) {
      const p = typeof L.at === 'function' ? L.at(t) : L.at.rec ? [L.at.x, L.at.y + 1.5, L.at.z] : L.at;
      ty = yawTo(ex, ez, p[0], p[2]) + (L.yawOff || 0); tp = pitchTo(ex, ey, ez, p[0], p[1], p[2]);
    } else { if (L.yaw !== undefined) ty = L.yaw; if (L.pitch !== undefined) tp = L.pitch; }
    // 目标角度展开到当前角度附近（走最短的那一圈）
    ty = this.yaw.x + wrap(ty - this.yaw.x);
    spring(this.yaw, ty, L.w, L.zeta, L.vmax, DT);
    spring(this.pitch, Math.max(-1.55, Math.min(1.55, tp)), L.w, L.zeta, L.vmax, DT);
  }
}

// 折线：按弧长取点、把一个点投影到折线上（只往前找，不会倒回去）
class Poly {
  constructor(pts) {
    this.p = pts.filter((q, i) => i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-3);
    this.cum = [0];
    for (let i = 1; i < this.p.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.p[i][0] - this.p[i - 1][0], this.p[i][1] - this.p[i - 1][1]));
    this.len = this.cum[this.cum.length - 1];
  }
  // extend：超过终点时沿最后一段的方向继续延长（给视线用）
  at(s, extend = false) {
    const p = this.p, n = p.length;
    if (n === 1) return p[0];
    if (s >= this.len) {
      if (!extend) return p[n - 1];
      const a = p[n - 2], b = p[n - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, e = s - this.len;
      return [b[0] + (b[0] - a[0]) / L * e, b[1] + (b[1] - a[1]) / L * e];
    }
    let i = 1; while (this.cum[i] < s) i++;
    const u = (s - this.cum[i - 1]) / (this.cum[i] - this.cum[i - 1] || 1);
    return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * u, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * u];
  }
  project(x, z, from) {
    let best = from, bd = Infinity;
    for (let i = 1; i < this.p.length; i++) {
      if (this.cum[i] < from - 0.01) continue;
      const a = this.p[i - 1], b = this.p[i], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
      const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)), s = this.cum[i - 1] + u * Math.sqrt(L2);
      if (s < from) continue;
      const d = Math.hypot(a[0] + dx * u - x, a[1] + dz * u - z);
      if (d < bd - 1e-6) { bd = d; best = s; }
      if (s > from + 6) break;
    }
    return best;
  }
}

// 取某一时刻的状态（相邻两个 120 Hz 样本之间线性插值）
export function sample(a, t) {
  const r = a.rec, n = r.x.length, f = Math.max(0, Math.min(n - 1.001, t * HZ)), i = Math.floor(f), u = f - i;
  const L = k => r[k][i] + (r[k][i + 1] - r[k][i]) * u;
  return { x: L('x'), y: L('y'), z: L('z'), yaw: L('yaw'), pitch: L('pitch'), bob: L('bob'), walked: L('walked'), limb: L('limb'), limbAmt: L('limbAmt'),
    body: L('body'), eye: L('eye'), armYaw: L('armYaw'), armPitch: L('armPitch'), vx: L('vx'), vz: L('vz'), ground: L('ground') };
}

// 原版的视角晃动：返回相机在自身坐标系里的平移和附加的侧倾、俯仰（弧度）
export function bobView(s) {
  const f1 = -s.walked * Math.PI, b = s.bob;
  return { x: Math.sin(f1) * b * 0.5, y: -Math.abs(Math.cos(f1) * b), roll: Math.sin(f1) * b * 3 * Math.PI / 180, pitch: Math.abs(Math.cos(f1 - 0.2) * b) * 5 * Math.PI / 180 };
}

// 把第一人称相机摆好：眼睛位置 + 晃动；yaw 0 朝北（−z）
export function placeCamera(cam, s, extra = {}) {
  const bv = bobView(s);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(s.pitch - bv.pitch + (extra.pitch || 0), -s.yaw + (extra.yaw || 0), -bv.roll + (extra.roll || 0));
  cam.position.set(s.x, s.y + s.eye, s.z);
  cam.updateMatrixWorld();
  // 晃动的平移在相机自己的坐标系里
  cam.translateX(bv.x); cam.translateY(bv.y);
  return bv;
}

// 这一时刻手在挥吗：返回 0..1 的挥动进度（6 tick = 0.3 秒）或 null
export function swingAt(a, t, dur = 0.3) {
  let p = null;
  for (const s of a.swings) if (t >= s.t && t < s.t + dur) p = (t - s.t) / dur;
  return p;
}
// 手里拿的东西：返回 { item, equip }（equip 0..1：换物品时手放下又抬起，原版每 tick 0.4）
export function heldAt(a, t) {
  let cur = null, prev = null;
  for (const h of a.items) if (h.t <= t) { prev = cur; cur = h; }
  if (!cur) return { item: null, equip: 1 };
  const u = (t - cur.t) / 0.35;
  // 前半段：旧的东西放下去；后半段：新的抬起来
  if (u < 0.5) return { item: prev ? prev.item : null, equip: 1 - u * 2 };
  return { item: cur.item, equip: Math.min(1, (u - 0.5) * 2) };
}

// 别人的身体姿势（原版 ModelBiped 的腿、手臂摆动）
export function limbs(s) {
  const a = Math.min(1, s.limbAmt), ph = s.limb * 0.6662;
  return { legR: Math.cos(ph) * 1.4 * a, legL: Math.cos(ph + Math.PI) * 1.4 * a, armR: Math.cos(ph + Math.PI) * 2.0 * a * 0.5, armL: Math.cos(ph) * 2.0 * a * 0.5 };
}
