"use strict";

/*
 * Live simulation of the momentum ranking algorithm.
 *
 * Momentum bookkeeping uses the incremental form of the spec's formula:
 * since every event of a type decays by the same base, the sum of
 * w · (1 - f)^t over all events equals an accumulator that gains 1 per
 * event and is multiplied by (1 - f)^dt each step. Weights are applied
 * at read time, so weight sliders act retroactively; decay changes act
 * from now on, like a live system retuning its rank settings would.
 */

const HOUR = 3600;
const DAY = 86400;
const RANK_EPS = 0.3;
const MAX_POSTS = 80;
const AGE_TICKS = [
	HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
	DAY, 2 * DAY, 4 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 90 * DAY, 180 * DAY, 365 * DAY,
];
const SPEED_STEPS = [
	HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 12 * HOUR,
	DAY, 2 * DAY, 3 * DAY, 5 * DAY, 7 * DAY,
];
const FEED_MAX = 30;
const TL_BUCKET = 600; // timeline series bucket: 10 simulated minutes
const TL_SPAN = 2.5 * DAY;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function halfLifeToFactor(hlSeconds) {
	return 1 - Math.pow(0.5, 1 / hlSeconds);
}

function fmtDuration(s) {
	if (s < HOUR) return Math.round(s / 60) + " min";
	if (s < 2 * DAY) return (s / HOUR).toFixed(1).replace(/\.0$/, "") + " h";
	if (s < 350 * DAY) return (s / DAY).toFixed(1).replace(/\.0$/, "") + " d";
	return (s / (365 * DAY)).toFixed(1).replace(/\.0$/, "") + " y";
}

function fmtAgeTick(s) {
	if (s < DAY) return Math.round(s / HOUR) + "h";
	if (s < 350 * DAY) return Math.round(s / DAY) + "d";
	return "1y";
}

function fmtAge(s) {
	if (s < HOUR) return Math.max(1, Math.round(s / 60)) + " min";
	if (s < 2 * DAY) return (s / HOUR).toFixed(1) + " h";
	return (s / DAY).toFixed(1) + " d";
}

function fmtScore(v) {
	if (v >= 100) return Math.round(v).toString();
	if (v >= 1) return v.toFixed(1);
	return v.toFixed(2);
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function weekdayOf(t) {
	return WEEKDAYS[Math.floor(t / DAY) % 7]; // Day 1 is a Monday
}

function isWeekend(t) {
	const wd = Math.floor(t / DAY) % 7;
	return wd === 5 || wd === 6;
}

// global activity level: a 24 h day/night cycle between 50% and 100%
// (trough around 04:00, peak around 16:00), times 80% on weekends
function activityFactor(t) {
	const daily = 0.75 + 0.25 * Math.sin(((t % DAY) / DAY - 4 / 24) * Math.PI * 2 - Math.PI / 2);
	return daily * (isWeekend(t) ? 0.8 : 1);
}

function fmtSimClock(t) {
	const day = Math.floor(t / DAY) + 1;
	const h = Math.floor((t % DAY) / HOUR);
	const m = Math.floor((t % HOUR) / 60);
	return "Day " + day + " (" + weekdayOf(t) + ") · " +
		String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

/* ---------- content ---------- */

const CONTENT = [
	["🌅", "Sunset over the harbor"],
	["🐱", "My cat discovered the printer"],
	["🍕", "Midnight pizza experiment"],
	["🎸", "First riff on the new guitar"],
	["🚲", "Gravel ride above the valley"],
	["📷", "Street shots from Tuesday"],
	["🌵", "The balcony cactus bloomed"],
	["🏔️", "Sunrise from the ridge"],
	["🍜", "Ramen from scratch, attempt 3"],
	["🎨", "Small study in gouache"],
	["🐙", "Octopus at the night dive"],
	["🛰️", "Caught the station flyover"],
	["🧩", "A 2000 piece mistake"],
	["🌊", "The swell finally arrived"],
	["🦜", "The parrot learned a new word"],
	["🍩", "Glazed and confused"],
	["⚽", "Sunday league golazo"],
	["🎬", "Cutting the short film"],
	["📚", "This novel wrecked me"],
	["🧗", "Finally sent the red route"],
	["🪴", "Repotting day"],
	["🥐", "Lamination is hard"],
	["🛶", "Dawn paddle on the lake"],
	["🎧", "The new mix is up"],
	["🐳", "Whales off the point"],
	["🌋", "Hiked to the crater rim"],
	["🚀", "Model rocket, second stage worked"],
	["🧵", "A thread about tiny keyboards"],
	["🍯", "First honey harvest"],
	["🌙", "Blood moon timelapse"],
];

/* ---------- parameters ---------- */

// weights and decay factors match a real production deployment of the
// algorithm: likes weigh 1 and comments 2.5, both dampened at 5e-5 per
// second (~3.9 h half-life), and the timeline age decay is 1e-8 per
// second (~2.2 year half-life)
const defaults = {
	likeWeight: 1,
	commentWeight: 2.5,
	momentumHalfLife: Math.log(2) / -Math.log(1 - 0.00005),
	newnessOn: true,
	newnessHalfLife: Math.log(2) / -Math.log(1 - 0.00000001),
	postsPerHour: 3,
	likesPerHour: 300,
	commentsPerHour: 45,
	skew: 0.9,
	speed: HOUR, // simulated seconds per real second
	ageWindow: 7 * DAY,
};

const params = Object.assign({}, defaults);

/* ---------- state ---------- */

const state = {
	simTime: 0,
	posts: [],
	particles: [],
	paused: false,
	nextId: 1,
	postCarry: 0,
	likeCarry: 0,
	commentCarry: 0,
	// no persistent user avatars: events originate from spawnPoint()
	rankedCount: 0,
	top: [],
	hoverPost: null,
	eventTimes: [],
	series: [],
	instantEvents: false,
};

let contentDeck = [];
const titleUses = new Map();

function nextContent() {
	if (!contentDeck.length) {
		contentDeck = CONTENT.slice();
		for (let i = contentDeck.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[contentDeck[i], contentDeck[j]] = [contentDeck[j], contentDeck[i]];
		}
	}
	return contentDeck.pop();
}

function makePost(birth) {
	const c = nextContent();
	const uses = (titleUses.get(c[1]) || 0) + 1;
	titleUses.set(c[1], uses);
	return {
		id: state.nextId++,
		emoji: c[0],
		title: uses > 1 ? c[1] + " · " + uses : c[1],
		birth,
		// how interesting this post is to the community, fixed at creation:
		// most posts are mediocre, a few are gems, some interest nobody
		interest: Math.random() < 0.12 ? 0 : Math.pow(Math.random(), 1.6),
		accLike: 0,
		accComment: 0,
		likes: 0,
		comments: 0,
		momentum: 0,
		score: 0,
		rank: -1,
		viralStart: 0,
		viralUntil: 0,
		viralStrength: 0,
		viralCount: 0,
		viralLikeCarry: 0,
		viralCommentCarry: 0,
		x: 0,
		y: 0,
		hasPos: false,
		flash: 0,
		alpha: 0,
		edgeFade: 1,
		dying: false,
	};
}

function applyEvent(post, type) {
	if (post.dying) return;
	if (type === "like") {
		post.accLike += 1;
		post.likes++;
	} else {
		post.accComment += 1;
		post.comments++;
	}
	post.flash = 1;
	state.eventTimes.push(performance.now());
	recordEvent(type);
}

function recordEvent(type) {
	const t0 = Math.floor(state.simTime / TL_BUCKET) * TL_BUCKET;
	let last = state.series[state.series.length - 1];
	if (!last || last.t !== t0) {
		last = { t: t0, likes: 0, comments: 0 };
		state.series.push(last);
	}
	if (type === "like") last.likes++;
	else last.comments++;
}

/* ---------- canvas ---------- */

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const chartPanel = document.getElementById("chartPanel");
const tlCanvas = document.getElementById("timeline");
const tlCtx = tlCanvas.getContext("2d");
const timePanel = document.getElementById("timePanel");
const view = {};

function fitCanvas(cv, panel, context) {
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	const r = panel.getBoundingClientRect();
	cv.width = Math.max(1, Math.round(r.width * dpr));
	cv.height = Math.max(1, Math.round(r.height * dpr));
	context.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resize() {
	fitCanvas(canvas, chartPanel, ctx);
	fitCanvas(tlCanvas, timePanel, tlCtx);
	computeView();
}

function computeView() {
	view.w = chartPanel.clientWidth;
	view.h = chartPanel.clientHeight;
	view.plotLeft = 64;
	view.plotRight = view.w - 46;
	view.plotTop = 72;
	view.shelfY = view.h - 78;
	view.plotBottom = view.shelfY - 40;
}

// events drop in from all around the post they are destined to
function spawnPoint(post) {
	const angle = rand(0, Math.PI * 2);
	const dist = radiusOf(post) + rand(28, 60);
	return {
		x: post.x + Math.cos(angle) * dist,
		y: post.y + Math.sin(angle) * dist,
	};
}

/* ---------- heat colors ---------- */

const HEAT_STOPS = [
	[0.0, [74, 85, 104]],
	[0.3, [122, 88, 60]],
	[0.6, [224, 138, 46]],
	[0.85, [255, 193, 77]],
	[1.0, [255, 243, 214]],
];

function heatColor(h, alpha) {
	h = clamp(h, 0, 1);
	let i = 0;
	while (i < HEAT_STOPS.length - 2 && h > HEAT_STOPS[i + 1][0]) i++;
	const [t0, c0] = HEAT_STOPS[i];
	const [t1, c1] = HEAT_STOPS[i + 1];
	const t = (h - t0) / (t1 - t0 || 1);
	const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
	const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
	const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
	return "rgba(" + r + "," + g + "," + b + "," + (alpha === undefined ? 1 : alpha) + ")";
}

function displayHeat(p) {
	const base = Math.log10(1 + p.momentum) / Math.log10(1 + 600);
	return clamp(base + p.flash * 0.25, 0, 1);
}

function radiusOf(p) {
	return clamp(6 + 1.7 * Math.sqrt(p.likes + 2 * p.comments), 6, 19);
}

/* ---------- simulation step ---------- */

function weightedPick(items, weightFn) {
	let total = 0;
	const weights = new Array(items.length);
	for (let i = 0; i < items.length; i++) {
		weights[i] = weightFn(items[i]);
		total += weights[i];
	}
	if (total <= 0) return null;
	let r = Math.random() * total;
	for (let i = 0; i < items.length; i++) {
		r -= weights[i];
		if (r <= 0) return items[i];
	}
	return items[items.length - 1];
}

function pickTarget(alive) {
	if (!alive.length) return null;
	if (Math.random() < 0.3) {
		// discovery: fresh posts get seen regardless of momentum, but only
		// as far as they interest the community
		return weightedPick(alive, p =>
			(Math.exp(-((state.simTime - p.birth) / HOUR) / 18) + 0.002) * p.interest);
	}
	// feed exposure: higher ranked posts are more visible, so they attract
	// more attention (Zipf-like falloff over rank positions), scaled by how
	// interesting each post actually is
	return weightedPick(alive, p =>
		(p.rank >= 0 ? Math.pow(p.rank + 1, -params.skew) : 0.01) * p.interest);
}

let particleBudget = 0;

function sendEvent(post, type) {
	// invisible targets (beyond the chart range) get their events silently
	if (state.instantEvents || post.edgeFade <= 0 ||
		particleBudget <= 0 || state.particles.length > 160) {
		applyEvent(post, type);
		return;
	}
	particleBudget--;
	const u = spawnPoint(post);
	state.particles.push({
		post,
		type,
		x0: u.x,
		y0: u.y,
		cx: (u.x + post.x) / 2 + rand(-24, 24),
		cy: (u.y + post.y) / 2,
		t: 0,
		dur: rand(0.45, 0.7),
	});
}

function emitEvent(type, alive) {
	const post = pickTarget(alive);
	if (post) sendEvent(post, type);
}

// a viral post receives an extra stream of likes and comments for a few
// hours, sized as a share of the whole network's rate: a fast ramp up,
// then a slow fade
function startViral(post, strength) {
	if (!post || post.dying) return;
	if (isViral(post)) {
		// going viral while already viral compounds: twice as strong, then
		// three times, and so on
		post.viralStrength += strength;
		post.viralCount++;
		post.viralUntil = Math.max(post.viralUntil, state.simTime + rand(4, 8) * HOUR);
		return;
	}
	post.viralStart = state.simTime;
	post.viralUntil = state.simTime + rand(4, 8) * HOUR;
	post.viralStrength = strength;
	post.viralCount = 1;
}

function isViral(p) {
	return p.viralUntil > state.simTime;
}

function pickOldPost() {
	const old = state.posts.filter(p =>
		!p.dying && p.interest > 0 && state.simTime - p.birth > 2 * DAY);
	if (!old.length) return null;
	// prefer the coldest ones, where the comeback is most dramatic
	return weightedPick(old, p => 1 / (p.momentum + 0.3));
}

function step(realDt) {
	const simDt = realDt * params.speed;
	state.simTime += simDt;

	const decay = Math.pow(1 - halfLifeToFactor(params.momentumHalfLife), simDt);
	for (const p of state.posts) {
		p.accLike *= decay;
		p.accComment *= decay;
	}

	const dtHours = simDt / HOUR;
	const act = activityFactor(state.simTime);

	state.postCarry += params.postsPerHour * act * dtHours;
	while (state.postCarry >= 1) {
		state.postCarry -= 1;
		state.posts.push(makePost(state.simTime));
	}

	state.likeCarry += params.likesPerHour * act * dtHours;
	state.commentCarry += params.commentsPerHour * act * dtHours;
	let likes = Math.min(1000, Math.floor(state.likeCarry));
	let comments = Math.min(300, Math.floor(state.commentCarry));
	state.likeCarry -= Math.floor(state.likeCarry);
	state.commentCarry -= Math.floor(state.commentCarry);
	const alive = state.posts.filter(p => !p.dying);
	while (likes-- > 0) emitEvent("like", alive);
	while (comments-- > 0) emitEvent("comment", alive);

	const commentRatio = params.commentsPerHour / Math.max(1, params.likesPerHour);
	for (const p of state.posts) {
		if (!isViral(p) || p.dying) continue;
		const u = (state.simTime - p.viralStart) / (p.viralUntil - p.viralStart);
		const shape = u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8;
		const rate = params.likesPerHour * p.viralStrength * shape * act;
		p.viralLikeCarry += rate * dtHours;
		p.viralCommentCarry += rate * commentRatio * dtHours;
		let vl = Math.min(40, Math.floor(p.viralLikeCarry));
		let vc = Math.min(15, Math.floor(p.viralCommentCarry));
		p.viralLikeCarry -= Math.floor(p.viralLikeCarry);
		p.viralCommentCarry -= Math.floor(p.viralCommentCarry);
		while (vl-- > 0) sendEvent(p, "like");
		while (vc-- > 0) sendEvent(p, "comment");
	}

	// occasionally an old post goes viral on its own, the algorithm's signature moment
	if (Math.random() < dtHours * 0.06) {
		startViral(pickOldPost(), 0.3);
	}

	// and rarely, a high-interest post catches fire spontaneously
	if (Math.random() < dtHours * 0.04) {
		const candidates = state.posts.filter(p => !p.dying && !isViral(p) && p.interest > 0.5);
		startViral(weightedPick(candidates, p => Math.pow(p.interest, 3)), 0.4);
	}

	while (state.series.length && state.series[0].t < state.simTime - TL_SPAN - 2 * TL_BUCKET) {
		state.series.shift();
	}

	updateRanking();
	cull();
}

function updateRanking() {
	const nf = params.newnessOn ? halfLifeToFactor(params.newnessHalfLife) : 0;
	const ranked = [];
	for (const p of state.posts) {
		p.momentum = params.likeWeight * p.accLike + params.commentWeight * p.accComment;
		const age = state.simTime - p.birth;
		p.score = nf > 0 ? p.momentum * Math.pow(1 - nf, age) : p.momentum;
		if (!p.dying && p.momentum >= RANK_EPS) {
			ranked.push(p);
		} else {
			p.rank = -1;
		}
	}
	ranked.sort((a, b) => b.score - a.score);
	for (let i = 0; i < ranked.length; i++) ranked[i].rank = i;
	state.rankedCount = ranked.length;
	state.top = ranked.slice(0, FEED_MAX);
}

function cull() {
	for (const p of state.posts) {
		if (!p.dying && state.simTime - p.birth > params.ageWindow + 12 * HOUR && p.momentum < 0.05) {
			p.dying = true;
		}
	}
	if (state.posts.length > MAX_POSTS) {
		// newborns score zero until their first likes arrive, which made
		// them the cull's first victims at the cap: give them a grace
		// period to earn their momentum
		const excess = state.posts
			.filter(p => !p.dying && state.simTime - p.birth > 12 * HOUR)
			.sort((a, b) => a.score - b.score || a.birth - b.birth)
			.slice(0, Math.max(0, state.posts.length - MAX_POSTS));
		for (const p of excess) p.dying = true;
	}
	state.posts = state.posts.filter(p => !(p.dying && p.alpha <= 0));
}

/* ---------- layout ---------- */

function ageToX(age) {
	// logarithmic age scale: the recent hours get room, old age compresses
	const t = Math.log1p(Math.max(0, age) / HOUR) / Math.log1p(params.ageWindow / HOUR);
	return view.plotRight - clamp(t, 0, 1) * (view.plotRight - view.plotLeft);
}

function layout(realDt) {
	computeView();
	const n = Math.max(10, state.rankedCount);
	const k = 1 - Math.exp(-realDt * 3.5);
	for (const p of state.posts) {
		const age = state.simTime - p.birth;
		const tx = ageToX(age);
		let ty;
		if (p.rank >= 0) {
			ty = view.plotTop + Math.pow(p.rank / Math.max(1, n - 1), 0.72) * (view.plotBottom - view.plotTop);
		} else {
			ty = view.shelfY + (p.id % 5) * 3;
		}
		if (!p.hasPos) {
			p.x = tx;
			p.y = view.shelfY;
			p.hasPos = true;
		}
		p.x += (tx - p.x) * k;
		p.y += (ty - p.y) * k;
		p.flash = Math.max(0, p.flash - realDt * 1.6);
		p.alpha = p.dying
			? Math.max(0, p.alpha - realDt * 1.4)
			: Math.min(1, p.alpha + realDt * 2.5);
		// posts older than the chart range are not drawn: fade them out
		// across the last stretch before the edge instead of popping
		p.edgeFade = clamp((params.ageWindow - age) / (params.ageWindow * 0.03), 0, 1);
	}
}

/* ---------- particles ---------- */

function bez(a, c, b, t) {
	const u = 1 - t;
	return u * u * a + 2 * u * t * c + t * t * b;
}

function updateParticles(realDt) {
	for (const pt of state.particles) {
		if (pt.post.edgeFade <= 0) {
			// the target slid out of the chart range mid-flight
			if (!pt.post.dying) applyEvent(pt.post, pt.type);
			pt.done = true;
			continue;
		}
		pt.t += realDt / pt.dur;
		if (pt.t >= 1) {
			if (!pt.post.dying) applyEvent(pt.post, pt.type);
			pt.done = true;
		}
	}
	state.particles = state.particles.filter(pt => !pt.done && !pt.post.dying);
}

/* ---------- drawing ---------- */

// clear the whole backing store: clearing view.w/h misses the fractional
// sliver at the right and bottom edges and glyphs smear there
function clearCanvas(context, cv) {
	context.save();
	context.setTransform(1, 0, 0, 1, 0, 0);
	context.clearRect(0, 0, cv.width, cv.height);
	context.restore();
}

function draw(now) {
	clearCanvas(ctx, canvas);
	drawAxes();

	const ordered = state.posts.slice().sort((a, b) => a.momentum - b.momentum);
	for (const p of ordered) drawPost(p);

	drawParticles();
}

function drawAxes() {
	ctx.save();
	ctx.strokeStyle = "rgba(255,255,255,0.055)";
	ctx.fillStyle = "rgba(160,175,195,0.55)";
	ctx.font = "11px sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	const ticks = [0].concat(AGE_TICKS.filter(t => t <= params.ageWindow));
	for (const tk of ticks) {
		const x = ageToX(tk);
		ctx.beginPath();
		ctx.moveTo(x, view.plotTop - 14);
		ctx.lineTo(x, view.shelfY + 26);
		ctx.stroke();
		ctx.fillText(tk === 0 ? "now" : fmtAgeTick(tk), x, view.shelfY + 32);
	}

	// dormant shelf
	ctx.strokeStyle = "rgba(255,255,255,0.09)";
	ctx.setLineDash([4, 6]);
	ctx.beginPath();
	ctx.moveTo(view.plotLeft - 20, view.shelfY - 24);
	ctx.lineTo(view.plotRight + 20, view.shelfY - 24);
	ctx.stroke();
	ctx.setLineDash([]);
	ctx.textAlign = "left";
	ctx.fillStyle = "rgba(160,175,195,0.45)";
	ctx.fillText("unranked · no momentum", view.plotLeft - 20, view.shelfY - 18);

	// rank cue, centered above the plot so it never hides behind the overlays
	ctx.textAlign = "center";
	ctx.fillStyle = "rgba(255,212,138,0.7)";
	ctx.fillText("↑ higher rank · #1 at the top", (view.plotLeft + view.plotRight) / 2, view.plotTop - 34);

	ctx.textAlign = "right";
	ctx.fillStyle = "rgba(160,175,195,0.45)";
	ctx.fillText("logarithmic post age", view.plotRight + 20, view.shelfY + 48);
	ctx.restore();
}

function drawPost(p) {
	const alpha = p.alpha * p.edgeFade;
	if (alpha <= 0) return;
	const r = radiusOf(p);
	const heat = displayHeat(p);

	ctx.save();
	ctx.globalAlpha = alpha;

	const glow = ctx.createRadialGradient(p.x, p.y, r * 0.2, p.x, p.y, r * 2.2);
	glow.addColorStop(0, heatColor(heat, 0.28 + heat * 0.35));
	glow.addColorStop(1, heatColor(heat, 0));
	ctx.fillStyle = glow;
	ctx.beginPath();
	ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
	ctx.fill();

	const body = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.35, r * 0.15, p.x, p.y, r);
	body.addColorStop(0, heatColor(Math.min(1, heat + 0.28)));
	body.addColorStop(1, heatColor(heat * 0.82));
	ctx.fillStyle = body;
	ctx.beginPath();
	ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
	ctx.fill();

	ctx.strokeStyle = p === state.hoverPost ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.14)";
	ctx.lineWidth = p === state.hoverPost ? 2 : 1;
	ctx.stroke();

	ctx.font = Math.round(r * 1.05) + "px sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(p.emoji, p.x, p.y + 1);

	if (isViral(p)) {
		const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
		ctx.strokeStyle = "rgba(255,196,90," + (0.35 + 0.4 * pulse).toFixed(2) + ")";
		ctx.lineWidth = 2;
		ctx.setLineDash([5, 4]);
		ctx.beginPath();
		ctx.arc(p.x, p.y, r + 6 + pulse * 2, 0, Math.PI * 2);
		ctx.stroke();
		ctx.setLineDash([]);
	}

	if (p.rank >= 0 && p.rank < 5) {
		ctx.font = "600 11px sans-serif";
		ctx.fillStyle = "rgba(255,217,138,0.95)";
		ctx.textBaseline = "bottom";
		ctx.fillText("#" + (p.rank + 1), p.x, p.y - r - 5);
	}
	ctx.restore();
}

function drawParticles() {
	ctx.save();
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	for (const pt of state.particles) {
		const t = clamp(pt.t, 0, 1);
		const x = bez(pt.x0, pt.cx, pt.post.x, t);
		const y = bez(pt.y0, pt.cy, pt.post.y, t);
		ctx.globalAlpha = 0.35 + 0.65 * t;
		if (pt.type === "like") {
			ctx.font = "11px sans-serif";
			ctx.fillStyle = "#ff5c7a";
			ctx.fillText("♥", x, y);
		} else {
			ctx.font = "10px sans-serif";
			ctx.fillText("💬", x, y);
		}
	}
	ctx.restore();
}

/* ---------- timeline ---------- */

function drawTimeline() {
	const w = timePanel.clientWidth;
	const h = timePanel.clientHeight;
	clearCanvas(tlCtx, tlCanvas);
	const left = 14;
	const right = w - 14;
	const top = 26;
	const bottom = h - 20;
	const t1 = state.simTime;
	const t0 = t1 - TL_SPAN;
	const xOf = t => left + ((t - t0) / TL_SPAN) * (right - left);

	tlCtx.save();

	// weekends run at 80% activity: shade them so the dip reads at a glance
	for (let d = Math.floor(t0 / DAY) * DAY; d < t1; d += DAY) {
		if (d < 0 || !isWeekend(d)) continue;
		const xa = xOf(Math.max(d, t0));
		const xb = xOf(Math.min(d + DAY, t1));
		tlCtx.fillStyle = "rgba(255,255,255,0.035)";
		tlCtx.fillRect(xa, 6, xb - xa, bottom - 6);
	}

	tlCtx.font = "10.5px sans-serif";
	tlCtx.textBaseline = "top";
	tlCtx.textAlign = "left";
	for (let t = Math.ceil(t0 / (6 * HOUR)) * 6 * HOUR; t <= t1; t += 6 * HOUR) {
		if (t < 0) continue; // before the network existed
		const isDay = t % DAY === 0;
		const x = xOf(t);
		tlCtx.strokeStyle = isDay ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.05)";
		tlCtx.beginPath();
		tlCtx.moveTo(x, isDay ? 8 : top);
		tlCtx.lineTo(x, bottom);
		tlCtx.stroke();
		if (isDay) {
			tlCtx.fillStyle = "rgba(160,175,195,0.75)";
			tlCtx.fillText("Day " + (Math.round(t / DAY) + 1) + " · " + weekdayOf(t), x + 5, 8);
		}
	}
	tlCtx.strokeStyle = "rgba(255,255,255,0.1)";
	tlCtx.beginPath();
	tlCtx.moveTo(left, bottom);
	tlCtx.lineTo(right, bottom);
	tlCtx.stroke();

	let max = 5;
	for (const b of state.series) {
		if (b.t >= t0) max = Math.max(max, b.likes, b.comments);
	}
	const yOf = v => bottom - (v / max) * (bottom - top);
	for (const [key, color] of [["likes", "#ff5c7a"], ["comments", "#5cc8ff"]]) {
		tlCtx.strokeStyle = color;
		tlCtx.lineWidth = 1.5;
		tlCtx.beginPath();
		let started = false;
		for (const b of state.series) {
			// skip the still-filling trailing buckets so the line does not dip at the edge
			if (b.t < t0 || b.t + 2 * TL_BUCKET > t1) continue;
			const x = xOf(b.t + TL_BUCKET / 2);
			const y = yOf(b[key]);
			if (started) tlCtx.lineTo(x, y);
			else tlCtx.moveTo(x, y);
			started = true;
		}
		tlCtx.stroke();
	}
	tlCtx.restore();
}

/* ---------- HUD, feed, tooltip ---------- */

const clockEl = document.getElementById("clock");
const statsEl = document.getElementById("stats");
const feedRowsEl = document.getElementById("feedRows");
const tooltipEl = document.getElementById("tooltip");
const feedEls = new Map();
let lastFeedUpdate = 0;

function updateHud(now) {
	if (now - lastFeedUpdate < 280) return;
	lastFeedUpdate = now;

	clockEl.textContent = fmtSimClock(state.simTime) + (state.paused ? " · paused" : "");
	let rate;
	if (screenshotMode && state.series.length > 1) {
		// the frozen world has no live event flow: estimate from the series
		const b = state.series[state.series.length - 2];
		rate = ((b.likes + b.comments) / TL_BUCKET) * params.speed;
	} else {
		const cutoff = performance.now() - 2000;
		state.eventTimes = state.eventTimes.filter(t => t >= cutoff);
		rate = state.eventTimes.length / 2;
	}
	statsEl.textContent =
		state.posts.length + " posts · " + state.rankedCount + " ranked · " +
		rate.toFixed(1) + " interactions/s";

	updateFeed();
}

function updateFeed() {
	feedRowsEl.style.height = Math.max(1, state.top.length * 52 - 8) + "px";
	const seen = new Set();
	state.top.forEach((p, i) => {
		seen.add(p.id);
		let el = feedEls.get(p.id);
		if (!el) {
			el = document.createElement("div");
			el.className = "feedRow";
			el.innerHTML =
				'<span class="pos"></span><span class="em"></span>' +
				'<span class="txt"><span class="t"></span><span class="meta"></span></span>' +
				'<span class="viralBadge">viral</span>';
			el.querySelector(".em").textContent = p.emoji;
			el.querySelector(".t").textContent = p.title;
			el.title = "Click to make this post go viral";
			el.addEventListener("click", () => startViral(p, 0.5));
			el.style.top = i * 52 + "px";
			el.style.opacity = "0";
			feedRowsEl.appendChild(el);
			requestAnimationFrame(() => (el.style.opacity = "1"));
			feedEls.set(p.id, el);
		}
		el.style.top = i * 52 + "px";
		const viral = isViral(p);
		el.classList.toggle("viral", viral);
		if (viral) {
			el.querySelector(".viralBadge").textContent =
				p.viralCount > 1 ? "viral x" + p.viralCount : "viral";
		}
		el.querySelector(".pos").textContent = "#" + (i + 1);
		el.querySelector(".meta").textContent =
			"♥ " + p.likes + " · 💬 " + p.comments + " · rank score " + fmtScore(p.score);
	});
	for (const [id, el] of feedEls) {
		if (!seen.has(id)) {
			feedEls.delete(id);
			el.style.opacity = "0";
			setTimeout(() => el.remove(), 320);
		}
	}
	if (!state.top.length && !feedRowsEl.querySelector(".feedEmpty")) {
		const e = document.createElement("p");
		e.className = "feedEmpty";
		e.textContent = "Nothing ranked yet";
		feedRowsEl.appendChild(e);
	} else if (state.top.length) {
		const e = feedRowsEl.querySelector(".feedEmpty");
		if (e) e.remove();
	}
}

function postAt(x, y) {
	let best = null;
	for (const p of state.posts) {
		if (p.alpha <= 0 || p.edgeFade <= 0) continue;
		const dx = x - p.x;
		const dy = y - p.y;
		if (dx * dx + dy * dy <= Math.pow(radiusOf(p) + 5, 2)) {
			if (!best || p.momentum > best.momentum) best = p;
		}
	}
	return best;
}

function canvasXY(e) {
	const r = canvas.getBoundingClientRect();
	return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener("mousemove", e => {
	const c = canvasXY(e);
	state.hoverPost = postAt(c.x, c.y);
	if (state.hoverPost) {
		const p = state.hoverPost;
		tooltipEl.hidden = false;
		tooltipEl.innerHTML =
			'<div class="tt"></div><div class="meta"></div><div class="hint">click = make this post go viral</div>';
		tooltipEl.querySelector(".tt").textContent = p.emoji + " " + p.title;
		tooltipEl.querySelector(".meta").textContent =
			"age " + fmtAge(state.simTime - p.birth) +
			" · interest " + Math.round(p.interest * 100) + "%" +
			" · ♥ " + p.likes + " · 💬 " + p.comments +
			" · momentum " + fmtScore(p.momentum) +
			(p.rank >= 0 ? " · rank #" + (p.rank + 1) : " · unranked") +
			(isViral(p) ? " · viral" + (p.viralCount > 1 ? " x" + p.viralCount : "") : "");
		tooltipEl.style.left = Math.min(e.clientX + 16, innerWidth - 290) + "px";
		tooltipEl.style.top = e.clientY + 16 + "px";
		canvas.style.cursor = "pointer";
	} else {
		tooltipEl.hidden = true;
		canvas.style.cursor = "default";
	}
});

canvas.addEventListener("click", e => {
	const c = canvasXY(e);
	const p = postAt(c.x, c.y);
	if (!p) return;
	startViral(p, 0.5);
	p.flash = 1;
});

/* ---------- controls ---------- */

const controlDefs = [
	{ id: "likeWeight", min: 0, max: 5, fmt: v => v.toFixed(1) },
	{ id: "commentWeight", min: 0, max: 5, fmt: v => v.toFixed(1) },
	{
		id: "momentumHalfLife", min: HOUR, max: 7 * DAY, log: true, fmt: fmtDuration,
		sub: v => "momentum decay factor ≈ " + halfLifeToFactor(v).toExponential(1) + " per second",
	},
	{
		id: "newnessHalfLife", min: 6 * HOUR, max: 4 * 365 * DAY, log: true, fmt: fmtDuration,
		sub: v => "age decay factor ≈ " + halfLifeToFactor(v).toExponential(1) + " per second",
	},
	{ id: "postsPerHour", min: 0.2, max: 12, log: true, fmt: v => v.toFixed(1) + " / sim hour" },
	{ id: "likesPerHour", min: 20, max: 3000, log: true, fmt: v => Math.round(v) + " / sim hour" },
	{ id: "commentsPerHour", min: 0, max: 600, fmt: v => Math.round(v) + " / sim hour" },
	{ id: "skew", min: 0, max: 2, fmt: v => v.toFixed(2) },
	{ id: "ageWindow", min: 7 * DAY, max: 365 * DAY, log: true, fmt: fmtDuration },
	{ id: "speed", steps: SPEED_STEPS, fmt: v => "1 s = " + fmtDuration(v) },
];

function toSlider(def, v) {
	if (def.steps) {
		let best = 0;
		for (let i = 1; i < def.steps.length; i++) {
			if (Math.abs(def.steps[i] - v) < Math.abs(def.steps[best] - v)) best = i;
		}
		return best;
	}
	if (def.log) return 1000 * Math.log(v / def.min) / Math.log(def.max / def.min);
	return 1000 * (v - def.min) / (def.max - def.min);
}

function fromSlider(def, s) {
	if (def.steps) return def.steps[clamp(Math.round(s), 0, def.steps.length - 1)];
	if (def.log) return def.min * Math.pow(def.max / def.min, s / 1000);
	return def.min + (def.max - def.min) * (s / 1000);
}

function syncControls() {
	for (const def of controlDefs) {
		const input = document.getElementById(def.id);
		const v = params[def.id];
		input.value = Math.round(toSlider(def, v));
		document.getElementById(def.id + "Val").textContent = def.fmt(v);
		if (def.sub) document.getElementById(def.id + "Sub").textContent = def.sub(v);
	}
	document.getElementById("newnessOn").checked = params.newnessOn;
	document.getElementById("newnessHalfLife").closest(".ctl")
		.classList.toggle("disabled", !params.newnessOn);
}

for (const def of controlDefs) {
	document.getElementById(def.id).addEventListener("input", e => {
		const v = fromSlider(def, Number(e.target.value));
		params[def.id] = v;
		document.getElementById(def.id + "Val").textContent = def.fmt(v);
		if (def.sub) document.getElementById(def.id + "Sub").textContent = def.sub(v);
	});
}

document.getElementById("newnessOn").addEventListener("change", e => {
	params.newnessOn = e.target.checked;
	document.getElementById("newnessHalfLife").closest(".ctl")
		.classList.toggle("disabled", !params.newnessOn);
});

const pauseBtn = document.getElementById("pauseBtn");

function setPaused(v) {
	state.paused = v;
	pauseBtn.textContent = v ? "Resume" : "Pause";
}

pauseBtn.addEventListener("click", () => setPaused(!state.paused));

document.getElementById("resetBtn").addEventListener("click", () => {
	Object.assign(params, defaults);
	resetSim();
	syncControls();
});

document.getElementById("panelToggle").addEventListener("click", () => {
	document.getElementById("row").classList.toggle("noPanel");
});

document.getElementById("fullscreenBtn").addEventListener("click", () => {
	if (document.fullscreenElement) document.exitFullscreen();
	else document.documentElement.requestFullscreen();
});

const intro = document.getElementById("intro");
document.getElementById("introClose").addEventListener("click", () => intro.classList.add("hidden"));
document.getElementById("helpBtn").addEventListener("click", () => intro.classList.remove("hidden"));
document.getElementById("moreHelp").addEventListener("click", e => {
	e.preventDefault();
	intro.classList.remove("hidden");
});

document.addEventListener("keydown", e => {
	if (e.code === "Space" && !intro.contains(document.activeElement)) {
		e.preventDefault();
		pauseBtn.click();
	}
});

window.addEventListener("resize", resize);
new ResizeObserver(resize).observe(chartPanel);
new ResizeObserver(resize).observe(timePanel);

/* ---------- fresh start ---------- */

// the simulation begins from an empty network at Day 1 (Monday) 00:00,
// then warms up by actually running the engine quietly for a week, so
// the world and the activity timeline start populated with an accurate,
// organically grown state
function resetSim() {
	state.simTime = 0;
	state.posts = [];
	state.particles = [];
	state.series = [];
	state.nextId = 1;
	state.postCarry = 0;
	state.likeCarry = 0;
	state.commentCarry = 0;
	updateRanking();
	warmup();
}

function warmup() {
	state.instantEvents = true;
	const stepReal = TL_BUCKET / params.speed;
	const steps = Math.round(7.25 * DAY / TL_BUCKET);
	for (let i = 0; i < steps; i++) step(stepReal);
	state.instantEvents = false;
	// the warmup pushed thousands of event timestamps within a few real
	// milliseconds: drop them so the HUD rate starts sane
	state.eventTimes = [];
}

/* ---------- screenshot mode ---------- */

function fastForward() {
	// the world is already warmed up by resetSim: stage a fresh viral and
	// some in-flight particles for the capture
	state.instantEvents = true;
	startViral(pickOldPost(), 0.5);
	const stepReal = TL_BUCKET / params.speed;
	for (let i = 0; i < 6; i++) step(stepReal);
	state.instantEvents = false;
	for (let i = 0; i < 10; i++) layout(0.5);
	const warm = state.posts.filter(p => p.rank >= 0 && p.rank < 12);
	for (let i = 0; i < 9; i++) {
		const post = pick(warm.length ? warm : state.posts);
		if (!post) break;
		const u = spawnPoint(post);
		state.particles.push({
			post,
			type: Math.random() < 0.75 ? "like" : "comment",
			x0: u.x,
			y0: u.y,
			cx: (u.x + post.x) / 2 + rand(-24, 24),
			cy: (u.y + post.y) / 2,
			t: rand(0.15, 0.75),
			dur: 1,
		});
	}
}

/* ---------- main loop ---------- */

let lastFrame = performance.now();
const screenshotMode = new URLSearchParams(location.search).has("screenshot");

function frame(now) {
	const realDt = clamp((now - lastFrame) / 1000, 0, 0.25);
	lastFrame = now;
	particleBudget = 22;

	// screenshot mode freezes the world after the fast-forward, so the
	// capture is deterministic no matter when the browser takes it
	if (!state.paused && !screenshotMode) {
		step(realDt);
		updateParticles(realDt);
	}
	layout(realDt);
	draw(now);
	drawTimeline();
	updateHud(now);
	requestAnimationFrame(frame);
}

resize();
resetSim();
syncControls();

if (screenshotMode) {
	fastForward();
}

requestAnimationFrame(frame);
