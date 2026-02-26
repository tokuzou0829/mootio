"use client";

import {
	Bodies,
	Body,
	Composite,
	Engine,
	Events,
	type IEventCollision,
	type Body as MatterBody,
	Runner,
} from "matter-js";
import Image from "next/image";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import { motionPermissionStore } from "@/components/shake/motion-permission-store";

type ShakeBlockProps = {
	className?: string;
	onShake?: () => void;
};

const ICON_URL = "/images/shake/f2d5e329-0736-463e-817a-3b3269b6acc2.svg";
const BASE_WIDTH = 390;
const BASE_HEIGHT = 844;
const BASE_BOX_SIZE = 64;
const BOX_RADIUS_RATIO = 20 / 64;
const ICON_WIDTH_RATIO = 36.454 / 64;
const ICON_HEIGHT_RATIO = 27.659 / 64;
const GRAVITY_SCALE = 0.0046;
const WALL_LABEL = "wall";
const BOX_LABEL = "box";
const VIBRATION_LIGHT = 12;
const VIBRATION_HEAVY = [12, 40, 12];
const VIBRATION_COOLDOWN = 140;
const SHAKE_FORCE_SCALE = 0.00034;
const SHAKE_JITTER = 0.45;
const SHAKE_COUNT_COOLDOWN = 350;
const SHAKE_THRESHOLD = 11;
const SHAKE_THRESHOLD_GRAVITY = 3.6;
const SHAKE_Z_INFLUENCE = 0.6;

const BASE_LAYOUT = [
	{ x: 32, y: 628, angle: 0 },
	{ x: 100.736, y: 623.736, angle: -25.79 },
	{ x: 171.306, y: 625.256, angle: 10.41 },
	{ x: 241.351, y: 623.731, angle: -33.53 },
	{ x: 314.351, y: 623.731, angle: -33.53 },
	{ x: 357.351, y: 572, angle: -33.53 },
	{ x: 135.279, y: 563.119, angle: 43.45 },
	{ x: 206.738, y: 564.178, angle: -12.01 },
	{ x: 280.307, y: 563.057, angle: 11 },
	{ x: 327.217, y: 508.417, angle: 11 },
	{ x: 246.695, y: 501.844, angle: -15.31 },
	{ x: 94.965, y: 501.644, angle: -15.31 },
	{ x: 25.038, y: 480.438, angle: 39.39 },
	{ x: 289.518, y: 447.328, angle: 39.39 },
	{ x: 218.351, y: 442.261, angle: -12.04 },
	{ x: 261.925, y: 382.666, angle: -100.81 },
	{ x: 358.705, y: 441.726, angle: -100.81 },
	{ x: 60.556, y: 563.056, angle: 39.36 },
	{ x: 166.866, y: 505.366, angle: 39.36 },
] as const;

type Layout = {
	boxSize: number;
	iconWidth: number;
	iconHeight: number;
	offsetX: number;
	offsetY: number;
	scale: number;
};

const DEFAULT_LAYOUT: Layout = {
	boxSize: BASE_BOX_SIZE,
	iconWidth: BASE_BOX_SIZE * ICON_WIDTH_RATIO,
	iconHeight: BASE_BOX_SIZE * ICON_HEIGHT_RATIO,
	offsetX: 0,
	offsetY: 0,
	scale: 1,
};

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

const getOrientationAngle = () => {
	if (typeof window === "undefined") {
		return 0;
	}
	const screenOrientation = window.screen?.orientation;
	if (typeof screenOrientation?.angle === "number") {
		return screenOrientation.angle;
	}
	const legacyOrientation = window.orientation;
	if (typeof legacyOrientation === "number") {
		return legacyOrientation < 0 ? 360 + legacyOrientation : legacyOrientation;
	}
	return 0;
};

const rotateVector = (vector: { x: number; y: number }, angle: number) => {
	const radians = (angle * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	return {
		x: vector.x * cos + vector.y * sin,
		y: -vector.x * sin + vector.y * cos,
	};
};

const computeLayout = (width: number, height: number): Layout => {
	const scale = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
	const offsetX = (width - BASE_WIDTH * scale) / 2;
	const offsetY = (height - BASE_HEIGHT * scale) / 2;
	const boxSize = BASE_BOX_SIZE * scale;
	return {
		boxSize,
		iconWidth: boxSize * ICON_WIDTH_RATIO,
		iconHeight: boxSize * ICON_HEIGHT_RATIO,
		offsetX,
		offsetY,
		scale,
	};
};

const getMotionPermissionRequirement = () => {
	const motionEvent =
		typeof DeviceMotionEvent === "undefined"
			? undefined
			: (DeviceMotionEvent as unknown as {
					requestPermission?: () => Promise<string>;
				});
	const orientationEvent =
		typeof DeviceOrientationEvent === "undefined"
			? undefined
			: (DeviceOrientationEvent as unknown as {
					requestPermission?: () => Promise<string>;
				});
	return Boolean(
		motionEvent?.requestPermission || orientationEvent?.requestPermission,
	);
};

export function ShakeBlock({ className, onShake }: ShakeBlockProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const boxRefs = useRef<(HTMLDivElement | null)[]>([]);
	const engineRef = useRef<Engine | null>(null);
	const runnerRef = useRef<Runner | null>(null);
	const bodiesRef = useRef<MatterBody[]>([]);
	const layoutRef = useRef<Layout>(DEFAULT_LAYOUT);
	const hasDeviceOrientationRef = useRef(false);
	const lastShakeRef = useRef(0);
	const lastShakeMagnitudeRef = useRef(0);
	const lastVibrateRef = useRef(0);
	const tiltGravityRef = useRef({ x: 0, y: 1 });
	const orientationAngleRef = useRef(0);
	const androidYAxisSignRef = useRef(1);
	const lastAccelRef = useRef<{ x: number; y: number; z: number } | null>(null);
	const autoRequestAttemptedRef = useRef(false);
	const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
	const [permissionOverride, setPermissionOverride] = useState<
		"unknown" | "granted" | "denied"
	>("unknown");
	const needsMotionPermission = useSyncExternalStore(
		() => () => {},
		getMotionPermissionRequirement,
		() => false,
	);
	const permissionState =
		permissionOverride === "unknown"
			? needsMotionPermission
				? "prompt"
				: "granted"
			: permissionOverride;

	useEffect(() => {
		if (typeof navigator === "undefined") {
			return;
		}
		if (!needsMotionPermission) {
			return;
		}
		if (permissionOverride !== "unknown") {
			return;
		}
		let isActive = true;
		const permissionNames = ["accelerometer", "gyroscope"] as const;
		const checkPermissions = async () => {
			if (typeof navigator.permissions?.query !== "function") {
				return;
			}
			try {
				const results = await Promise.all(
					permissionNames.map((name) =>
						navigator.permissions.query({
							name: name as PermissionName,
						}),
					),
				);
				if (!isActive) {
					return;
				}
				const states = results.map((result) => result.state);
				if (states.every((state) => state === "granted")) {
					setPermissionOverride("granted");
					return;
				}
				if (states.some((state) => state === "denied")) {
					setPermissionOverride("denied");
				}
			} catch {
				// noop
			}
		};
		void checkPermissions();

		let timeoutId: number | null = null;
		const handleMotionGranted = () => {
			if (!isActive) {
				return;
			}
			setPermissionOverride("granted");
		};
		const handleMotionEvent = () => {
			handleMotionGranted();
		};
		window.addEventListener("deviceorientation", handleMotionEvent);
		window.addEventListener("devicemotion", handleMotionEvent);
		timeoutId = window.setTimeout(() => {
			window.removeEventListener("deviceorientation", handleMotionEvent);
			window.removeEventListener("devicemotion", handleMotionEvent);
		}, 800);
		return () => {
			isActive = false;
			window.removeEventListener("deviceorientation", handleMotionEvent);
			window.removeEventListener("devicemotion", handleMotionEvent);
			if (timeoutId != null) {
				window.clearTimeout(timeoutId);
			}
		};
	}, [needsMotionPermission, permissionOverride]);

	useEffect(() => {
		motionPermissionStore.setState({
			permissionState,
			needsMotionPermission,
		});
	}, [needsMotionPermission, permissionState]);

	const boxStyle = useMemo(() => {
		const radius = Math.round(layout.boxSize * BOX_RADIUS_RATIO);
		return {
			width: `${layout.boxSize}px`,
			height: `${layout.boxSize}px`,
			borderRadius: `${radius}px`,
		};
	}, [layout.boxSize]);

	const iconStyle = useMemo(
		() => ({
			width: `${layout.iconWidth}px`,
			height: `${layout.iconHeight}px`,
		}),
		[layout.iconHeight, layout.iconWidth],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return;
		}

		const engine = Engine.create();
		engine.gravity.scale = GRAVITY_SCALE;
		engineRef.current = engine;

		const runner = Runner.create();
		runnerRef.current = runner;
		Runner.run(runner, engine);

		const syncDom = () => {
			const { boxSize } = layoutRef.current;
			for (let index = 0; index < bodiesRef.current.length; index += 1) {
				const body = bodiesRef.current[index];
				const box = boxRefs.current[index];
				if (!box) {
					continue;
				}
				const x = body.position.x - boxSize / 2;
				const y = body.position.y - boxSize / 2;
				box.style.transform = `translate3d(${x}px, ${y}px, 0) rotate(${body.angle}rad)`;
			}
		};

		const resetWorld = () => {
			const rect = container.getBoundingClientRect();
			const nextLayout = computeLayout(rect.width, rect.height);
			layoutRef.current = nextLayout;
			setLayout(nextLayout);

			Composite.clear(engine.world, false);

			const wallThickness = Math.max(60, nextLayout.boxSize);
			const halfWall = wallThickness / 2;

			const walls = [
				Bodies.rectangle(
					rect.width / 2,
					-1 * halfWall,
					rect.width + wallThickness * 2,
					wallThickness,
					{ isStatic: true, label: WALL_LABEL },
				),
				Bodies.rectangle(
					rect.width / 2,
					rect.height + halfWall,
					rect.width + wallThickness * 2,
					wallThickness,
					{ isStatic: true, label: WALL_LABEL },
				),
				Bodies.rectangle(
					-1 * halfWall,
					rect.height / 2,
					wallThickness,
					rect.height + wallThickness * 2,
					{ isStatic: true, label: WALL_LABEL },
				),
				Bodies.rectangle(
					rect.width + halfWall,
					rect.height / 2,
					wallThickness,
					rect.height + wallThickness * 2,
					{ isStatic: true, label: WALL_LABEL },
				),
			];
			Composite.add(engine.world, walls);

			const boxes = BASE_LAYOUT.map((box) =>
				Bodies.rectangle(
					box.x * nextLayout.scale + nextLayout.offsetX,
					box.y * nextLayout.scale + nextLayout.offsetY,
					nextLayout.boxSize,
					nextLayout.boxSize,
					{
						restitution: 0.86,
						friction: 0.03,
						frictionAir: 0.012,
						label: BOX_LABEL,
						angle: toRadians(box.angle),
					},
				),
			);
			bodiesRef.current = boxes;
			Composite.add(engine.world, boxes);
			syncDom();
		};

		resetWorld();

		const canVibrate =
			typeof navigator !== "undefined" &&
			typeof navigator.vibrate === "function";

		const handleCollisionStart = (event: IEventCollision<Engine>) => {
			if (!canVibrate) {
				return;
			}
			const now = performance.now();
			if (now - lastVibrateRef.current < VIBRATION_COOLDOWN) {
				return;
			}
			for (const pair of event.pairs) {
				const isWallA = pair.bodyA.label === WALL_LABEL;
				const isWallB = pair.bodyB.label === WALL_LABEL;
				if (!isWallA && !isWallB) {
					continue;
				}
				const boxBody = isWallA ? pair.bodyB : pair.bodyA;
				if (boxBody.label !== BOX_LABEL) {
					continue;
				}
				const wallBody = isWallA ? pair.bodyA : pair.bodyB;
				const relativeSpeed = Math.hypot(
					boxBody.velocity.x - wallBody.velocity.x,
					boxBody.velocity.y - wallBody.velocity.y,
				);
				const depth = pair.collision.depth;
				const impact = relativeSpeed + depth * 1.4;
				if (impact < 2.2) {
					continue;
				}
				navigator.vibrate(impact > 5.5 ? VIBRATION_HEAVY : VIBRATION_LIGHT);
				lastVibrateRef.current = now;
				break;
			}
		};

		const handleAfterUpdate = () => {
			syncDom();
		};
		Events.on(engine, "afterUpdate", handleAfterUpdate);
		Events.on(engine, "collisionStart", handleCollisionStart);

		const resizeObserver = new ResizeObserver(() => {
			resetWorld();
		});
		resizeObserver.observe(container);

		const handlePointerMove = (event: PointerEvent) => {
			if (hasDeviceOrientationRef.current) {
				return;
			}
			const rect = container.getBoundingClientRect();
			const x = (event.clientX - rect.left - rect.width / 2) / (rect.width / 2);
			const y =
				(event.clientY - rect.top - rect.height / 2) / (rect.height / 2);
			engine.gravity.x = clamp(x, -1, 1);
			engine.gravity.y = clamp(y, -1, 1);
		};

		const handlePointerLeave = () => {
			if (hasDeviceOrientationRef.current) {
				return;
			}
			engine.gravity.x = 0;
			engine.gravity.y = 1;
		};

		const handlePointerDown = () => {
			if (hasDeviceOrientationRef.current) {
				return;
			}
			const force = { x: 0, y: -0.02 };
			for (const body of bodiesRef.current) {
				Body.applyForce(body, body.position, force);
			}
		};

		container.addEventListener("pointermove", handlePointerMove);
		container.addEventListener("pointerleave", handlePointerLeave);
		container.addEventListener("pointerdown", handlePointerDown);

		return () => {
			container.removeEventListener("pointermove", handlePointerMove);
			container.removeEventListener("pointerleave", handlePointerLeave);
			container.removeEventListener("pointerdown", handlePointerDown);
			resizeObserver.disconnect();
			Events.off(engine, "afterUpdate", handleAfterUpdate);
			Events.off(engine, "collisionStart", handleCollisionStart);
			Runner.stop(runner);
			Engine.clear(engine);
		};
	}, []);

	const requestMotionPermission = useCallback(
		async (source: "auto" | "user") => {
			const motionEvent =
				typeof DeviceMotionEvent === "undefined"
					? undefined
					: (DeviceMotionEvent as unknown as {
							requestPermission?: () => Promise<string>;
						});
			const orientationEvent =
				typeof DeviceOrientationEvent === "undefined"
					? undefined
					: (DeviceOrientationEvent as unknown as {
							requestPermission?: () => Promise<string>;
						});
			if (
				!motionEvent?.requestPermission &&
				!orientationEvent?.requestPermission
			) {
				setPermissionOverride("granted");
				return;
			}
			try {
				const motionResult = motionEvent?.requestPermission
					? await motionEvent.requestPermission()
					: "granted";
				const orientationResult = orientationEvent?.requestPermission
					? await orientationEvent.requestPermission()
					: "granted";
				if (motionResult === "granted" && orientationResult === "granted") {
					setPermissionOverride("granted");
					return;
				}
				if (motionResult === "denied" || orientationResult === "denied") {
					setPermissionOverride("denied");
					return;
				}
				if (source === "user") {
					setPermissionOverride("denied");
				}
			} catch {
				if (source === "user") {
					setPermissionOverride("denied");
				}
			}
		},
		[],
	);

	useEffect(() => {
		motionPermissionStore.setRequestPermission(requestMotionPermission);
		return () => {
			motionPermissionStore.setRequestPermission(null);
		};
	}, [requestMotionPermission]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		const userAgent = window.navigator.userAgent ?? "";
		if (/Android/i.test(userAgent)) {
			androidYAxisSignRef.current = -1;
		}
	}, []);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		const updateAngle = () => {
			orientationAngleRef.current = getOrientationAngle();
		};
		updateAngle();
		window.addEventListener("orientationchange", updateAngle);
		window.addEventListener("resize", updateAngle);
		return () => {
			window.removeEventListener("orientationchange", updateAngle);
			window.removeEventListener("resize", updateAngle);
		};
	}, []);

	useEffect(() => {
		if (permissionState !== "prompt") {
			return;
		}
		if (autoRequestAttemptedRef.current) {
			return;
		}
		autoRequestAttemptedRef.current = true;
		const timeoutId = window.setTimeout(() => {
			void requestMotionPermission("auto");
		}, 0);
		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [permissionState, requestMotionPermission]);

	useEffect(() => {
		if (permissionState !== "granted") {
			return;
		}
		const engine = engineRef.current;
		if (!engine) {
			return;
		}

		const handleOrientation = (event: DeviceOrientationEvent) => {
			if (event.gamma == null || event.beta == null) {
				return;
			}
			hasDeviceOrientationRef.current = true;
			const angle = orientationAngleRef.current;
			const ySign = androidYAxisSignRef.current;
			const rawX = event.gamma / 45;
			const rawY = (event.beta / 45) * ySign;
			const rotated = rotateVector({ x: rawX, y: rawY }, angle);
			const x = clamp(rotated.x, -1, 1);
			const y = clamp(rotated.y, -1, 1);
			tiltGravityRef.current = { x, y };
			engine.gravity.x = x;
			engine.gravity.y = y;
		};

		const handleMotion = (event: DeviceMotionEvent) => {
			const acceleration = event.acceleration;
			const accelerationIncludingGravity = event.accelerationIncludingGravity;
			if (!acceleration && !accelerationIncludingGravity) {
				return;
			}
			hasDeviceOrientationRef.current = true;
			const angle = orientationAngleRef.current;
			const ySign = androidYAxisSignRef.current;
			const toScreen = (x: number, y: number) =>
				rotateVector({ x, y: -y * ySign }, angle);

			const accelScreen = acceleration
				? (() => {
						const rotated = toScreen(acceleration.x ?? 0, acceleration.y ?? 0);
						return {
							x: rotated.x,
							y: rotated.y,
							z: acceleration.z ?? 0,
						};
					})()
				: null;
			const gravityScreen = accelerationIncludingGravity
				? (() => {
						const rotated = toScreen(
							accelerationIncludingGravity.x ?? 0,
							accelerationIncludingGravity.y ?? 0,
						);
						return {
							x: rotated.x,
							y: rotated.y,
							z: accelerationIncludingGravity.z ?? 0,
						};
					})()
				: null;

			const gravityMagnitude = gravityScreen
				? Math.sqrt(
						gravityScreen.x * gravityScreen.x +
							gravityScreen.y * gravityScreen.y +
							gravityScreen.z * gravityScreen.z,
					)
				: 0;
			const baseGravity =
				gravityScreen && gravityMagnitude > 0.001
					? {
							x: clamp(gravityScreen.x / gravityMagnitude, -1.1, 1.1),
							y: clamp(gravityScreen.y / gravityMagnitude, -1.1, 1.1),
						}
					: tiltGravityRef.current;
			tiltGravityRef.current = baseGravity;

			const lastAccel = lastAccelRef.current;
			const deltaAccel =
				!accelScreen && gravityScreen && lastAccel
					? {
							x: gravityScreen.x - lastAccel.x,
							y: gravityScreen.y - lastAccel.y,
							z: gravityScreen.z - lastAccel.z,
						}
					: null;
			if (gravityScreen) {
				lastAccelRef.current = gravityScreen;
			}

			const linear = accelScreen ?? deltaAccel;
			const zBlend = linear ? (linear.z ?? 0) * SHAKE_Z_INFLUENCE : 0;
			const mixX = linear ? linear.x + baseGravity.x * zBlend : 0;
			const mixY = linear ? linear.y + baseGravity.y * zBlend : 0;
			const inertiaScale = accelScreen ? 1.2 : 1;
			const inertiaClamp = accelScreen ? 1.6 : 1.4;
			const inertiaX = linear
				? clamp((-mixX / 9.8) * inertiaScale, -inertiaClamp, inertiaClamp)
				: 0;
			const inertiaY = linear
				? clamp((-mixY / 9.8) * inertiaScale, -inertiaClamp, inertiaClamp)
				: 0;
			engine.gravity.x = clamp(baseGravity.x + inertiaX, -1.6, 1.6);
			engine.gravity.y = clamp(baseGravity.y + inertiaY, -1.6, 1.6);

			if (!linear) {
				return;
			}
			const magnitude = Math.sqrt(
				linear.x * linear.x + linear.y * linear.y + linear.z * linear.z,
			);
			const threshold = accelScreen ? SHAKE_THRESHOLD : SHAKE_THRESHOLD_GRAVITY;
			const prevMagnitude = lastShakeMagnitudeRef.current;
			lastShakeMagnitudeRef.current = magnitude;
			if (magnitude < threshold) {
				return;
			}
			if (prevMagnitude >= threshold) {
				return;
			}
			const now = performance.now();
			if (now - lastShakeRef.current < SHAKE_COUNT_COOLDOWN) {
				return;
			}
			lastShakeRef.current = now;
			onShake?.();
			const forceScale = SHAKE_FORCE_SCALE * magnitude;
			const divisor = accelScreen ? 12 : 5.5;
			const baseX = clamp(mixX / divisor, -1, 1);
			const baseY = clamp(mixY / divisor, -1, 1);
			for (const body of bodiesRef.current) {
				const jitterX = (Math.random() - 0.5) * SHAKE_JITTER;
				const jitterY = (Math.random() - 0.5) * SHAKE_JITTER;
				Body.applyForce(body, body.position, {
					x: (baseX + jitterX) * forceScale,
					y: (baseY + jitterY) * forceScale,
				});
				Body.setAngularVelocity(
					body,
					body.angularVelocity + (Math.random() - 0.5) * 0.7,
				);
			}
		};

		window.addEventListener("deviceorientation", handleOrientation);
		window.addEventListener("devicemotion", handleMotion);

		return () => {
			window.removeEventListener("deviceorientation", handleOrientation);
			window.removeEventListener("devicemotion", handleMotion);
		};
	}, [permissionState, onShake]);

	const rootClassName = [
		"relative h-full w-full overflow-hidden bg-transparent touch-none",
		className ?? "",
	]
		.join(" ")
		.trim();

	return (
		<div className={rootClassName} ref={containerRef}>
			<div className="absolute inset-0">
				{BASE_LAYOUT.map((box, index) => (
					<div
						key={`shake-block-${box.x}-${box.y}-${box.angle}`}
						ref={(node) => {
							boxRefs.current[index] = node;
						}}
						className="absolute left-0 top-0 will-change-transform"
					>
						<div
							className="relative overflow-hidden bg-[rgba(255,255,255,0.24)]"
							style={boxStyle}
						>
							<div
								className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
								style={iconStyle}
							>
								<Image
									alt=""
									src={ICON_URL}
									width={layout.iconWidth}
									height={layout.iconHeight}
									className="block h-full w-full"
									preload={true}
								/>
							</div>
							<div
								className="pointer-events-none absolute inset-0 rounded-[inherit]"
								style={{
									boxShadow: "inset 0 0 24px 0 rgba(255,255,255,0.64)",
								}}
							/>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
