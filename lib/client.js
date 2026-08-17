window.__ModuleLoader__.load({ id: "dsh-voice-input", factory: (require) => {

	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	var react = require("react");
	var react_jsx_runtime = require("react/jsx-runtime");

	//#region css
	// Styling mirrors Workbuddy's design language (CSS variables, radii, motion):
	//  - panel: liquid-glass surface (blur + translucent fill), matching the app shell
	//  - controls: pill buttons with the same hover/active semantics as the input bar
	var cssText = [
		".dvi-btn{position:relative;display:grid;place-items:center;width:28px;height:28px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;transition:background-color .15s,color .15s}",
		".dvi-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
		".dvi-btn:disabled{opacity:.4;cursor:default}",
		".dvi-btn[data-recording=true]{color:#ff3b30;background:rgba(255,59,48,.12)}",
		".dvi-btn[data-transcribing=true]{color:var(--dsw-alias-label-primary);opacity:.7;cursor:progress}",
		".dvi-btn svg{width:16px;height:16px}",
		".dvi-pulse{position:absolute;inset:-3px;border-radius:999px;border:1.5px solid rgba(255,59,48,.4);opacity:0}",
		".dvi-btn[data-recording=true] .dvi-pulse{animation:dvi-pulse 1.2s ease-out infinite}",
		"@keyframes dvi-pulse{0%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.35)}}",
		".dvi-spin{animation:dvi-rot .6s linear infinite;transform-origin:center}",
		"@keyframes dvi-rot{to{transform:rotate(360deg)}}",
		".dvi-root{position:relative;display:inline-flex;align-items:center;flex:none}",
		".dvi-toast{position:absolute;top:calc(100% + 12px);left:50%;transform:translateX(-50%);background:rgba(28,28,30,.92);color:#fff;border-radius:8px;padding:5px 12px;font-size:12.5px;line-height:18px;pointer-events:none;z-index:9999;white-space:nowrap;animation:dvi-fade .15s ease-out}",
		"@keyframes dvi-fade{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}",

		/* ── Recording panel: white mini-card anchored under the mic button ── */
		".dvi-panel{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:12px;z-index:10000;background:#fff;border:0.5px solid rgba(0,0,0,.08);box-shadow:0 6px 24px rgba(0,0,0,.35),0 1px 3px rgba(0,0,0,.2);animation:dvi-panel-in .16s ease-out;user-select:none;white-space:nowrap}",
		"@keyframes dvi-panel-in{from{opacity:0;transform:translateX(-50%) scale(.97)}to{opacity:1;transform:translateX(-50%) scale(1)}}",
		/* mic glyph + live level bars */
		".dvi-mic-wrap{display:flex;align-items:center;gap:6px;flex:none}",
		".dvi-mic-glyph{position:relative;display:grid;place-items:center;width:30px;height:30px;border-radius:50%;color:#ff3b30;background:rgba(255,59,48,.12)}",
		".dvi-mic-glyph svg{width:15px;height:15px;transition:transform .1s ease}",
		".dvi-bars{display:flex;align-items:center;gap:2px;height:18px;flex:none}",
		".dvi-bar{width:3px;border-radius:2px;background:#c7c7cc;transition:height .09s ease;height:3px}",
		".dvi-bar[data-hot=true]{background:#ff3b30}",
		/* timer */
		".dvi-time{font-size:15px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums;color:#1c1c1e;min-width:44px;text-align:center;flex:none}",
		/* action buttons */
		".dvi-actions{display:flex;align-items:center;gap:6px;flex:none}",
		".dvi-act{width:28px;height:28px;padding:0;display:grid;place-items:center;border:none;border-radius:50%;cursor:pointer;transition:transform .12s ease,background-color .15s ease,opacity .15s;flex:none}",
		".dvi-act svg{width:15px;height:15px}",
		".dvi-act:active{transform:scale(.92)}",
		".dvi-act-stop{color:#fff;background:#ff3b30}",
		".dvi-act-stop:hover{background:#ff5045}",
		".dvi-act-cancel{color:#6e6e73;background:rgba(0,0,0,.06)}",
		".dvi-act-cancel:hover{background:rgba(0,0,0,.12)}"
	].join("");
	var cssTag = "dsh-voice-input/client.css";
	if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTag) + "]")) {
		var s = document.createElement("style");
		s.dataset.plugin = "dsh-voice-input";
		s.dataset.pluginCss = cssTag;
		s.textContent = cssText;
		document.head.appendChild(s);
	}
	//#endregion

	//#region icons
	function MicIcon() {
		return react_jsx_runtime.jsx("svg", {
			viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", "aria-hidden": true,
			children: react_jsx_runtime.jsx("path", {
				d: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3ZM19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V21a1 1 0 1 0 2 0v-3.08A7 7 0 0 0 19 11Z",
				fill: "currentColor"
			})
		});
	}

	function StopIcon() {
		return react_jsx_runtime.jsx("svg", {
			viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", "aria-hidden": true,
			children: react_jsx_runtime.jsx("rect", {
				x: "7", y: "7", width: "10", height: "10", rx: "2.5", fill: "currentColor"
			})
		});
	}

	function XIcon() {
		return react_jsx_runtime.jsx("svg", {
			viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", "aria-hidden": true,
			children: react_jsx_runtime.jsx("path", {
				d: "M6.4 5.6a1 1 0 0 0 0 1.4L10.6 12l-4.2 5a1 1 0 1 0 1.5 1.3L12 13.4l4.1 4.9a1 1 0 1 0 1.5-1.3L13.4 12l4.2-5a1 1 0 1 0-1.5-1.3L12 10.6 7.9 5.7a1 1 0 0 0-1.5 0Z",
				fill: "currentColor"
			})
		});
	}

	function SpinnerIcon() {
		return react_jsx_runtime.jsx("svg", {
			viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", "aria-hidden": true,
			className: "dvi-spin",
			children: react_jsx_runtime.jsx("path", {
				d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14Z",
				fill: "currentColor", opacity: "0.2"
			})
		});
	}
	//#endregion

	//#region helpers
	function formatTime(seconds) {
		var m = Math.floor(seconds / 60);
		var s = seconds % 60;
		return m + ":" + (s < 10 ? "0" + s : s);
	}

	function pickMimeType() {
		var types = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
		for (var i = 0; i < types.length; i++) {
			if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) {
				return types[i];
			}
		}
		return "";
	}
	//#endregion

	//#region VoiceInputButton
	function VoiceInputButton(props) {
		var getDraft = props.getDraft;
		var setDraft = props.setDraft;

		// State: "idle" | "recording" | "transcribing"
		var stateRef = react.useRef("idle");
		var stateHook = react.useState("idle");
		var state = stateHook[0];
		var setState = stateHook[1];

		function updateState(s) {
			stateRef.current = s;
			setState(s);
		}

		var toastState = react.useState(null);
		var toast = toastState[0];
		var setToast = toastState[1];

		var toastTimer = react.useRef(0);
		var timerRef = react.useRef(0);
		var elapsedRef = react.useRef(0);
		var elapsedHook = react.useState(0);
		var setElapsed = elapsedHook[1];

		var mediaRecorderRef = react.useRef(null);
		var streamRef = react.useRef(null);
		var chunksRef = react.useRef([]);
		var baseDraftRef = react.useRef("");
		var mimeTypeRef = react.useRef("");
		var insertTextRef = react.useRef(function () {});
		var sysModeRef = react.useRef(false);

		// Live mic level (0-100) for the recording panel animation
		var levelRef = react.useRef(0);
		var levelHook = react.useState(0);
		var setLevel = levelHook[1];
		var levelTimerRef = react.useRef(0);

		var showToast = react.useCallback(function (text, duration) {
			setToast(text);
			window.clearTimeout(toastTimer.current);
			toastTimer.current = window.setTimeout(function () {
				setToast(null);
			}, duration || 3000);
		}, []);

		function stopTimer() {
			if (timerRef.current) {
				window.clearInterval(timerRef.current);
				timerRef.current = 0;
			}
		}

		function stopLevelPolling() {
			if (levelTimerRef.current) {
				window.clearInterval(levelTimerRef.current);
				levelTimerRef.current = 0;
			}
		}

		function cleanupStream() {
			if (streamRef.current) {
				streamRef.current.getTracks().forEach(function (track) {
					try { track.stop(); } catch (e) {}
				});
				streamRef.current = null;
			}
		}

		react.useEffect(function () {
			// Listen for transcribed text from the standalone recorder page
			function handleMessage(event) {
				if (!event || !event.data) return;
				if (event.data.type === "dsh-voice-text" && event.data.text) {
					insertTextRef.current(event.data.text);
					showToast("已从浏览器接收语音文字", 2000);
					updateState("idle");
				} else if (event.data.type === "dsh-voice-closed") {
					if (stateRef.current === "transcribing") {
						updateState("idle");
					}
				}
			}
			window.addEventListener("message", handleMessage);

			return function () {
				window.removeEventListener("message", handleMessage);
				window.clearTimeout(toastTimer.current);
				stopTimer();
				stopLevelPolling();
				cleanupStream();
			};
		}, []);

		function startTimer() {
			elapsedRef.current = 0;
			setElapsed(0);
			timerRef.current = window.setInterval(function () {
				elapsedRef.current += 1;
				setElapsed(elapsedRef.current);
				// Auto-stop at 60 seconds
				if (elapsedRef.current >= 60) {
					stopRecording();
				}
			}, 1000);
		}

		// Poll the live mic level (~10Hz) while recording via system microphone
		function startLevelPolling() {
			stopLevelPolling();
			var poll = function () {
				fetch("/dsh-voice-input/record/level", { method: "GET" })
					.then(function (res) { return res.ok ? res.json() : null; })
					.then(function (data) {
						if (data && typeof data.level === "number") {
							levelRef.current = data.level;
							setLevel(data.level);
						}
					})
					.catch(function () {});
			};
			poll();
			levelTimerRef.current = window.setInterval(poll, 120);
		}

		function insertText(text) {
			if (!text) return;
			if (typeof setDraft === "function") {
				var base = baseDraftRef.current;
				// Add space or newline if needed
				var separator = "";
				if (base && !base.endsWith("\n") && !base.endsWith(" ")) {
					separator = " ";
				}
				setDraft(base + separator + text);
			}
		}
		insertTextRef.current = insertText;

		function transcribeAudio(blob) {
			updateState("transcribing");
			showToast("正在转写…", 60000);

			var mimeType = mimeTypeRef.current || "audio/webm";
			fetch("/dsh-voice-input/transcribe", {
				method: "POST",
				headers: { "Content-Type": mimeType },
				body: blob
			}).then(function (res) {
				if (!res.ok) throw new Error("HTTP " + res.status);
				return res.json();
			}).then(function (data) {
				if (data.text) {
					insertText(data.text);
					showToast("已识别 (" + (data.source || "unknown") + ")", 1500);
				} else if (data.error && data.error.includes("Python")) {
					showToast("未配置语音识别，请阅读 README 配置 API Key", 5000);
				} else if (data.error) {
					showToast("转写失败: " + data.error, 4000);
				} else {
					showToast("未识别到语音", 3000);
				}
			}).catch(function (err) {
				var msg = err && err.message ? err.message : String(err);
				if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
					showToast("无法连接转写服务，请重启 DSH", 4000);
				} else {
					showToast("转写失败: " + msg, 4000);
				}
			}).finally(function () {
				updateState("idle");
			});
		}

		async function stopRecording() {
			stopTimer();
			stopLevelPolling();

			// System-level recording path
			if (sysModeRef.current) {
				sysModeRef.current = false;
				updateState("transcribing");
				showToast("正在转写…", 60000);
				try {
					var res = await fetch("/dsh-voice-input/record/stop", { method: "POST" });
					var data = await res.json();
					if (data && data.ok && data.text) {
						insertText(data.text);
						showToast("已识别 (" + (data.source || "unknown") + ")", 1500);
					} else if (data && data.error) {
						showToast("转写失败: " + data.error, 4000);
					} else {
						showToast("未识别到语音", 3000);
					}
				} catch (err) {
					var msg = err && err.message ? err.message : String(err);
					if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
						showToast("无法连接转写服务，请重启 DSH", 4000);
					} else {
						showToast("转写失败: " + msg, 4000);
					}
				}
				updateState("idle");
				return;
			}

			// Browser MediaRecorder path
			var rec = mediaRecorderRef.current;
			if (rec && rec.state !== "inactive") {
				try { rec.stop(); } catch (e) {}
			}
			cleanupStream();
		}

		async function cancelRecording() {
			stopTimer();
			stopLevelPolling();

			// System-level recording path: tell server to kill + discard
			if (sysModeRef.current) {
				sysModeRef.current = false;
				try {
					await fetch("/dsh-voice-input/record/cancel", { method: "POST" });
				} catch (e) {}
				updateState("idle");
				showToast("已取消录音", 1500);
				return;
			}

			// Browser MediaRecorder path: stop tracks, drop chunks
			var rec = mediaRecorderRef.current;
			if (rec && rec.state !== "inactive") {
				try {
					rec.onstop = null; // prevent transcribe on cancel
					rec.stop();
				} catch (e) {}
			}
			chunksRef.current = [];
			cleanupStream();
			updateState("idle");
			showToast("已取消录音", 1500);
		}

		function openRecorderPage() {
			// Save current draft as base for when text comes back
			baseDraftRef.current = typeof getDraft === "function" ? (getDraft() || "") : "";

			var url = window.location.origin + "/dsh-voice-input/recorder";
			var opened = false;
			try {
				var win = window.open(url, "_blank");
				if (win) opened = true;
			} catch (e) {}

			if (opened) {
				updateState("transcribing");
				showToast("已在浏览器打开录音页面，录音完成后文字将自动填入", 8000);
			} else {
				// Popup blocked — show URL for manual copy
				updateState("transcribing");
				showToast("请用浏览器打开: " + url, 15000);
			}
		}

		async function startRecording() {
			// Save current draft as base
			baseDraftRef.current = typeof getDraft === "function" ? (getDraft() || "") : "";

			// ── Path 1: system-level recording (works inside DSH webview) ──
			try {
				var sysRes = await fetch("/dsh-voice-input/record/start", { method: "POST" });
				var sysData = await sysRes.json();
				if (sysData && sysData.ok) {
					sysModeRef.current = true;
					updateState("recording");
					startTimer();
					startLevelPolling();
					return;
				}
				if (sysData && sysData.error) {
					console.warn("[dsh-voice-input] system record failed:", sysData.error);
				}
			} catch (e) {
				console.warn("[dsh-voice-input] system record error:", e);
			}
			sysModeRef.current = false;

			// ── Path 2: browser getUserMedia ───────────────────
			// Pre-flight checks
			// 1) navigator.mediaDevices must exist
			if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
				showToast("DSH 客户端不支持录音，正在打开浏览器录音页面…", 3000);
				openRecorderPage();
				return;
			}

			// 2) Must be a secure context (HTTPS or localhost)
			if (!window.isSecureContext) {
				var host = window.location.hostname || "";
				if (host && host !== "localhost" && host !== "127.0.0.1" && !host.startsWith("localhost:")) {
					showToast("正在打开浏览器录音页面…", 3000);
					openRecorderPage();
				} else {
					showToast("当前页面非安全上下文，正在打开浏览器录音页面…", 3000);
					openRecorderPage();
				}
				return;
			}

			// 3) Check permission state before calling getUserMedia
			//    "denied" = user previously rejected → browser won't show dialog again
			//    "prompt"  = fresh → browser WILL show the dialog
			//    "granted" = already allowed
			var permState = "prompt";
			try {
				if (navigator.permissions && navigator.permissions.query) {
					var result = await navigator.permissions.query({ name: "microphone" });
					permState = result.state; // "granted" | "denied" | "prompt"
				}
			} catch (e) {
				// permissions API not available, fall through to getUserMedia
			}

			if (permState === "denied") {
				showToast("麦克风已被拒绝。请点击地址栏左侧的 🔒/🎤 图标，将麦克风改为「允许」后刷新页面", 8000);
				return;
			}

			var mimeType = pickMimeType();
			mimeTypeRef.current = mimeType;

			var constraints = {
				audio: {
					channelCount: 1,
					sampleRate: 16000,
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true
				}
			};

			navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
				streamRef.current = stream;
				chunksRef.current = [];

				var options = {};
				if (mimeType) options.mimeType = mimeType;

				var rec = new MediaRecorder(stream, options);
				mediaRecorderRef.current = rec;

				rec.ondataavailable = function (event) {
					if (event.data && event.data.size > 0) {
						chunksRef.current.push(event.data);
					}
				};

				rec.onstop = function () {
					var blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
					chunksRef.current = [];

					// Check if recording is too short (< 0.3s)
					if (elapsedRef.current < 1 && blob.size < 5000) {
						showToast("录音太短，请长按说话", 2000);
						updateState("idle");
						return;
					}

					transcribeAudio(blob);
				};

				rec.onerror = function (event) {
					showToast("录音错误", 3000);
					updateState("idle");
					cleanupStream();
					stopTimer();
					stopLevelPolling();
				};

				rec.start();
				updateState("recording");
				startTimer();

			}).catch(function (err) {
				var name = err && err.name ? err.name : "";
				if (name === "NotAllowedError" || name === "PermissionDeniedError") {
					// DSH webview typically auto-denies without dialog → open recorder in system browser
					showToast("DSH 客户端无法直接录音，正在打开浏览器录音页面…", 3000);
					openRecorderPage();
				} else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
					showToast("未检测到麦克风设备", 3000);
				} else if (name === "NotReadableError") {
					showToast("麦克风被其他程序占用，请关闭后重试", 4000);
				} else if (name === "OverconstrainedError") {
					// Retry without constraints
					showToast("正在重试…", 2000);
					navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream2) {
						streamRef.current = stream2;
						chunksRef.current = [];
						var rec2 = new MediaRecorder(stream2, mimeType ? { mimeType: mimeType } : {});
						mediaRecorderRef.current = rec2;
						rec2.ondataavailable = function (ev) {
							if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
						};
						rec2.onstop = function () {
							var blob2 = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
							chunksRef.current = [];
							if (elapsedRef.current < 1 && blob2.size < 5000) {
								showToast("录音太短，请长按说话", 2000);
								updateState("idle");
								return;
							}
							transcribeAudio(blob2);
						};
						rec2.onerror = function () {
							showToast("录音错误", 3000);
							updateState("idle");
							cleanupStream();
							stopTimer();
							stopLevelPolling();
						};
					rec2.start();
					updateState("recording");
					startTimer();
					}).catch(function () {
						showToast("无法启动录音，请检查麦克风权限", 5000);
						updateState("idle");
					});
					return;
				} else {
					showToast("无法启动录音: " + (err && err.message ? err.message : name), 4000);
				}
				updateState("idle");
			});
		}

		var handleClick = react.useCallback(function () {
			var current = stateRef.current;
			if (current === "recording") {
				stopRecording();
			} else if (current === "transcribing") {
				// Allow canceling — user can click to reset
				updateState("idle");
				showToast(null, 1);
			} else {
				startRecording();
			}
		}, []);

		// ── Recording panel (shown while state === "recording") ──
		function renderPanel() {
			var level = levelRef.current;
			// Scale mic glyph slightly with level (1.0 → 1.35)
			var scale = 1 + Math.min(level, 100) / 100 * 0.35;
			// 5 bars; heights derived from level so they "breathe"
			var bars = [0, 1, 2, 3, 4].map(function (i) {
				var h = 3;
				if (level > 0) {
					var wave = Math.sin((levelRef.current * 0.35) + i * 1.4) * 0.4 + 0.6;
					h = Math.max(4, Math.min(18, 3 + (level / 100) * 15 * wave));
				}
				return react_jsx_runtime.jsx("span", {
					className: "dvi-bar",
					"data-hot": level > 55 ? "true" : "false",
					style: { height: Math.round(h) + "px" },
					key: i
				});
			});

			return react_jsx_runtime.jsxs("div", {
				className: "dvi-panel",
				children: [
					/* Left: mic glyph + live level bars */
					react_jsx_runtime.jsxs("div", {
						className: "dvi-mic-wrap",
						children: [
							react_jsx_runtime.jsxs("span", {
								className: "dvi-mic-glyph",
								children: [
									react_jsx_runtime.jsx("span", { className: "dvi-pulse" }),
									react_jsx_runtime.jsx(MicIcon, {})
								]
							}),
							react_jsx_runtime.jsx("span", {
								className: "dvi-bars",
								children: bars
							})
						]
					}),
					/* Middle: MM:SS timer */
					react_jsx_runtime.jsx("span", {
						className: "dvi-time",
						children: formatTime(elapsedRef.current)
					}),
					/* Right: stop (commit+transcribe) / cancel (discard) */
					react_jsx_runtime.jsxs("div", {
						className: "dvi-actions",
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dvi-act dvi-act-stop",
								onClick: function () { stopRecording(); },
								title: "停止并上传",
								children: react_jsx_runtime.jsx(StopIcon, {})
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								className: "dvi-act dvi-act-cancel",
								onClick: function () { cancelRecording(); },
								title: "取消录音（丢弃）",
								children: react_jsx_runtime.jsx(XIcon, {})
							})
						]
					})
				]
			});
		}

		// Render
		// Toast anchored under the mic button (never centered on screen)
		function renderToast() {
			if (!toast) return null;
			return react_jsx_runtime.jsx("div", {
				className: "dvi-toast",
				children: toast
			}, "toast");
		}

		var icon;
		if (state === "recording") {
			icon = react_jsx_runtime.jsx(StopIcon, {});
		} else if (state === "transcribing") {
			icon = react_jsx_runtime.jsx(SpinnerIcon, {});
		} else {
			icon = react_jsx_runtime.jsx(MicIcon, {});
		}

		var btnChildren = [
			react_jsx_runtime.jsx("span", { className: "dvi-pulse", key: "pulse" }),
			react_jsx_runtime.jsx("span", {
				style: { display: "grid", placeItems: "center", width: "100%", height: "100%" },
				children: icon,
				key: "icon"
			})
		];

		var t = renderToast();

		return react_jsx_runtime.jsxs("span", {
			className: "dvi-root",
			children: [
				react_jsx_runtime.jsx("button", {
					type: "button",
					className: "dvi-btn",
					"data-recording": state === "recording" ? "true" : "false",
					"data-transcribing": state === "transcribing" ? "true" : "false",
					disabled: state === "transcribing",
					"aria-label": "语音输入",
					title: "语音输入",
					onClick: handleClick,
					children: btnChildren
				}, "btn"),
				state === "recording" ? renderPanel() : null,
				t
			]
		});
	}
	//#endregion

	//#region apply
	var inject = ["slots", "sessions"];

	function apply(ctx) {
		ctx.slots.inject("conversation.input.right", function () {
			return ctx.slots.register({
				name: "conversation.input.right",
				id: "voice-input",
				order: 10,
				inject: function (sessionId) {
					if (sessionId === void 0) return {};
					try {
						var actx = ctx.sessions.scope(sessionId);
						if (actx === void 0) return {};
						var conversation = actx.get("conversation");
						if (conversation === void 0) return {};
						var shell = conversation.input.for(actx);
						if (shell === void 0) return {};
						return {
							getDraft: function () { return shell.snapshot.draft; },
							setDraft: function (text) { shell.setDraft(text); }
						};
					} catch (e) {
						return {};
					}
				}
			}, VoiceInputButton);
		});
	}

	exports.apply = apply;
	exports.inject = inject;
	return module.exports;

}});
