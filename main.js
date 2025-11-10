import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import JSZip from 'jszip';
import nipplejs from 'nipplejs';
import { CharacterController } from './characterController.js';

class App {
    constructor() {
        this.loader = document.getElementById('loader');
        this.loaderText = document.getElementById('loader-text');
        this.uploadPrompt = document.getElementById('upload-prompt');
        this.controlsElement = document.getElementById('controls');

        this.init();
        this.setupEventListeners();
    }

    init() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x333333);
        this.scene.fog = new THREE.Fog(0x333333, 10, 50);

        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(0, 1.5, 5);

        const canvas = document.querySelector('#c');
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.shadowMap.enabled = true;

        const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
        this.scene.add(hemiLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 3);
        dirLight.position.set(5, 5, 5);
        dirLight.castShadow = true;
        this.scene.add(dirLight);

        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(100, 100),
            new THREE.MeshStandardMaterial({ color: 0x444444 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.scene.add(ground);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.target.set(0, 1, 0);
        this.controls.update();
        this.controls.enablePan = false;
        this.controls.maxPolarAngle = Math.PI / 2;

        this.clock = new THREE.Clock();
        this.characterController = null;
        this.keys = {};

        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    setupEventListeners() {
        const uploadButton = document.getElementById('upload-button');
        const fileInput = document.getElementById('file-input');
        uploadButton.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => this.handleFileUpload(e));

        window.addEventListener('resize', () => this.onWindowResize());

        document.addEventListener('keydown', (e) => { this.keys[e.key.toLowerCase()] = true; });
        document.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
    }

    async handleFileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        this.showLoader('Unzipping file...');
        this.uploadPrompt.classList.add('hidden');

        try {
            const zip = await JSZip.loadAsync(file);
            const fileMap = new Map();
            const objectURLs = [];

            let modelFile = null;

            for (const filename in zip.files) {
                if (!zip.files[filename].dir) {
                    const blob = await zip.files[filename].async('blob');
                    const url = URL.createObjectURL(blob);
                    objectURLs.push(url);
                    fileMap.set(filename.toLowerCase(), url);

                    if (filename.endsWith('.gltf') || filename.endsWith('.glb')) {
                        modelFile = url;
                    }
                }
            }

            if (!modelFile) {
                throw new Error('No .gltf or .glb file found in the zip.');
            }

            // Find the path of the model file to resolve relative assets
            let modelPath = '';
            for (const [key, value] of fileMap.entries()) {
                if (value === modelFile) {
                    const lastSlash = key.lastIndexOf('/');
                    if (lastSlash !== -1) {
                        modelPath = key.substring(0, lastSlash + 1);
                    }
                    break;
                }
            }

            // Setup a custom loading manager to resolve local blob URLs
            const manager = new THREE.LoadingManager();
            manager.setURLModifier((url) => {
                // url is the relative path from the GLTF file
                // We construct the full path within the zip and look it up

                // The 'url' can be a full path or relative. It might also be URI encoded.
                const decodedUrl = decodeURIComponent(url);

                // Construct the full path within the zip.
                // modelPath already has a trailing slash if it's in a subdirectory.
                const resolvedPath = modelPath + decodedUrl;

                // Normalize path separators to handle cases where the GLTF uses '\'
                const normalizedPath = resolvedPath.replace(/\\/g, '/').toLowerCase();

                const blobUrl = fileMap.get(normalizedPath);

                if (blobUrl) {
                    return blobUrl;
                }

                // Fallback for cases where the path might not need the modelPath prefix
                // (e.g., if the GLTF uses absolute paths within the zip)
                const fallbackPath = decodedUrl.replace(/\\/g, '/').toLowerCase();
                return fileMap.get(fallbackPath) || url;
            });

            this.showLoader('Loading model...');
            const gltfLoader = new GLTFLoader(manager);
            gltfLoader.load(modelFile, async (gltf) => {
                try { // Add try/catch for post-load processing
                    this.showLoader('Analyzing animations with AI...');

                    const model = gltf.scene;
                    model.traverse(c => {
                        c.castShadow = true;
                    });

                    const mixer = new THREE.AnimationMixer(model);
                    const clipNames = gltf.animations.map(clip => clip.name);
                    const mappedAnimations = await this.mapAnimationsAI(clipNames, gltf.animations, mixer);

                    this.characterController = new CharacterController(model, mixer, mappedAnimations, this.camera, this.controls);
                    this.scene.add(model);

                    this.setupMobileControls();
                    this.controlsElement.classList.remove('hidden');
                    document.getElementById('jump-button').onclick = () => this.characterController.jump();

                    this.hideLoader();
                    objectURLs.forEach(url => URL.revokeObjectURL(url)); // Clean up
                } catch(error) {
                    console.error("Error processing loaded model:", error);
                    this.showToast('Error processing model.', error);
                    this.hideLoader();
                    this.uploadPrompt.classList.remove('hidden');
                }
            }, undefined, (error) => {
                console.error(error);
                this.showToast('Error loading model.', error);
                this.hideLoader();
                this.uploadPrompt.classList.remove('hidden');
            });

        } catch (error) {
            console.error(error);
            this.showToast('Error processing zip file.', error);
            this.hideLoader();
            this.uploadPrompt.classList.remove('hidden');
        }
    }

    async mapAnimationsAI(clipNames, clips, mixer) {
        const prompt = `
            You are an expert in 3D animation. Your task is to map a list of animation clip names to a standard set of character actions.
            The standard actions are: "idle", "walk", "run", "jump".
            Analyze the provided list of clip names and determine the best match for each standard action.
            It's okay if not all standard actions can be mapped. A "walk" can be used for "run" if no run animation is available.
            An "idle" is the most important one. Look for names like 'idle', 'static', 'pose'.
            A "walk" might be 'walk', 'walking', 'move'.
            A "run" might be 'run', 'sprint'.
            A "jump" might be 'jump', 'leap'.
            Respond ONLY with a JSON object where keys are the standard action names ("idle", "walk", "run", "jump") and values are the corresponding clip names from the list.
            If no suitable match is found for an action, do not include that key in the JSON.
            Example Response:
            {
              "idle": "CharacterArmature|Idle",
              "walk": "mixamo.com|Walking",
              "run": "Run",
              "jump": "Jump_Up"
            }

            Here is the list of animation clip names:
            ${JSON.stringify(clipNames)}
        `;

        const completion = await websim.chat.completions.create({
            messages: [{ role: 'user', content: prompt }], 
            json: true,
        });

        const mapping = JSON.parse(completion.content);
        const actions = {};

        console.log("AI Animation Mapping:", mapping);

        for (const actionName in mapping) {
            const clipName = mapping[actionName];
            const clip = THREE.AnimationClip.findByName(clips, clipName);
            if (clip) {
                const action = mixer.clipAction(clip);
                actions[actionName] = action;
            }
        }

        // Fallback for run animation
        if (actions.walk && !actions.run) {
            actions.run = actions.walk;
        }

        if (!actions.idle) {
            throw new Error("AI could not map an 'idle' animation. Character cannot be loaded.");
        }

        return actions;
    }

    setupMobileControls() {
        const joystickZone = document.getElementById('joystick-zone');
        const options = {
            zone: joystickZone,
            mode: 'static',
            position: { left: '50%', top: '50%' },
            color: 'white',
            size: 120,
        };
        const manager = nipplejs.create(options);

        this.joystick = { forward: 0, turn: 0 };

        manager.on('move', (evt, data) => {
            const forward = -Math.sin(data.angle.radian);
            const turn = -Math.cos(data.angle.radian);
            this.joystick.forward = forward * (data.distance / (options.size/2));
            this.joystick.turn = turn * (data.distance / (options.size/2));
        });

        manager.on('end', () => {
            this.joystick.forward = 0;
            this.joystick.turn = 0;
        });
    }

    showToast(message, error = null) {
        const toastContainer = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast';
    
        const messageElement = document.createElement('p');
        messageElement.className = 'toast-message';
        messageElement.textContent = message;
        toast.appendChild(messageElement);
    
        if (error) {
            const copyButton = document.createElement('button');
            copyButton.className = 'toast-copy-button';
            copyButton.textContent = 'Copy Details';
            copyButton.onclick = () => {
                const errorDetails = error.stack || error.toString();
                navigator.clipboard.writeText(errorDetails)
                    .then(() => {
                        copyButton.textContent = 'Copied!';
                        setTimeout(() => copyButton.textContent = 'Copy Details', 2000);
                    })
                    .catch(err => {
                        console.error('Failed to copy error details:', err);
                        copyButton.textContent = 'Copy Failed';
                    });
            };
            toast.appendChild(copyButton);
        }
    
        toastContainer.appendChild(toast);
    
        // Trigger the animation
        setTimeout(() => {
            toast.classList.add('show');
        }, 10);
    
        // Auto-hide
        setTimeout(() => {
            toast.classList.remove('show');
            // Remove element after transition finishes
            toast.addEventListener('transitionend', () => toast.remove());
        }, 10000); // 10 seconds
    }

    showLoader(text) {
        this.loaderText.textContent = text;
        this.loader.classList.remove('hidden');
    }

    hideLoader() {
        this.loader.classList.add('hidden');
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(this.animate);
        const delta = this.clock.getDelta();

        if (this.characterController) {
            const move = { forward: 0, turn: 0 };

            // Keyboard controls
            if (this.keys['w'] || this.keys['arrowup']) move.forward = 1;
            if (this.keys['s'] || this.keys['arrowdown']) move.forward = -1;
            if (this.keys['a'] || this.keys['arrowleft']) move.turn = 1;
            if (this.keys['d'] || this.keys['arrowright']) move.turn = -1;
            if (this.keys[' ']) this.characterController.jump();

            // Mobile/Joystick controls (override keyboard if active)
            if(Math.abs(this.joystick.forward) > 0.1 || Math.abs(this.joystick.turn) > 0.1){
                move.forward = -this.joystick.forward;
                move.turn = this.joystick.turn;
            }

            this.characterController.update(delta, move, this.keys['shift']);
        }

        this.renderer.render(this.scene, this.camera);
    }
}

new App();