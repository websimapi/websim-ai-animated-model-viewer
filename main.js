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

            // Setup a custom loading manager to resolve local blob URLs
            const manager = new THREE.LoadingManager();
            manager.setURLModifier((url) => {
                const normalizedUrl = url.replace(modelFile.substring(0, modelFile.lastIndexOf('/') + 1), '').toLowerCase();
                return fileMap.get(normalizedUrl) || url;
            });

            this.showLoader('Loading model...');
            const gltfLoader = new GLTFLoader(manager);
            gltfLoader.load(modelFile, async (gltf) => {
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
            }, undefined, (error) => {
                console.error(error);
                alert('Error loading model. Check console for details.');
                this.hideLoader();
                this.uploadPrompt.classList.remove('hidden');
            });

        } catch (error) {
            console.error(error);
            alert('Error processing zip file. Please ensure it is a valid zip containing a gltf/glb model.');
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