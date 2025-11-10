import * as THREE from 'three';

const FADE_DURATION = 0.2;

export class CharacterController {
    constructor(model, mixer, animations, camera, controls) {
        this.model = model;
        this.mixer = mixer;
        this.camera = camera;
        this.orbitControls = controls;

        this.actions = animations;
        this.activeAction = null;
        this.currentState = 'idle';

        this.moveDirection = new THREE.Vector3();
        this.rotationAxis = new THREE.Vector3(0, 1, 0);
        this.velocity = new THREE.Vector3();
        this.isJumping = false;

        this.playAction('idle');
    }

    playAction(name) {
        if (this.currentState === name || !this.actions[name]) return;

        const newAction = this.actions[name];
        const oldAction = this.activeAction;
        this.currentState = name;
        this.activeAction = newAction;

        if (oldAction) {
            oldAction.fadeOut(FADE_DURATION);
        }

        newAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(FADE_DURATION).play();
    }

    jump() {
        if (this.actions.jump && !this.isJumping) {
            this.isJumping = true;
            this.playAction('jump');
            this.velocity.y = 5.0; // Jump force

            // When jump animation finishes, go back to idle or movement
            const onJumpFinish = (e) => {
                if (e.action === this.actions.jump) {
                    this.mixer.removeEventListener('finished', onJumpFinish);
                    // Let the update loop handle the next state
                    this.isJumping = false; 
                }
            };
            this.mixer.addEventListener('finished', onJumpFinish);
        }
    }

    update(delta, move, isRunning) {
        this.mixer.update(delta);

        const moveSpeed = isRunning && this.actions.run ? 4.0 : 2.0;
        const turnSpeed = 3.0;

        // --- Ground movement ---
        if (!this.isJumping) {
             if (Math.abs(move.forward) > 0.1 || Math.abs(move.turn) > 0.1) {
                if (isRunning && this.actions.run) {
                    this.playAction('run');
                } else {
                    this.playAction('walk');
                }
            } else {
                this.playAction('idle');
            }
        }

        // --- Physics and Position ---
        // Apply gravity
        this.velocity.y -= 9.8 * delta;

        // Calculate movement direction based on camera
        const cameraDirection = new THREE.Vector3();
        this.camera.getWorldDirection(cameraDirection);
        cameraDirection.y = 0;
        cameraDirection.normalize();

        const right = new THREE.Vector3().crossVectors(this.camera.up, cameraDirection).normalize();

        this.moveDirection.set(0, 0, 0);
        this.moveDirection.add(cameraDirection.multiplyScalar(-move.forward));
        this.moveDirection.add(right.multiplyScalar(-move.turn));
        this.moveDirection.normalize();

        if (this.moveDirection.length() > 0.1) {
            const targetQuaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.moveDirection);
            this.model.quaternion.slerp(targetQuaternion, delta * turnSpeed * 5);
        }

        this.model.position.x += this.moveDirection.x * moveSpeed * delta;
        this.model.position.z += this.moveDirection.z * moveSpeed * delta;
        this.model.position.y += this.velocity.y * delta;

        // Simple ground collision
        if (this.model.position.y < 0) {
            this.model.position.y = 0;
            this.velocity.y = 0;
            if(this.isJumping) this.isJumping = false;
        }

        // --- Camera Follow ---
        const idealOffset = new THREE.Vector3(-1, 2, -4);
        idealOffset.applyQuaternion(this.model.quaternion);
        idealOffset.add(this.model.position);

        const idealLookat = new THREE.Vector3(0, 1.5, 0);
        idealLookat.add(this.model.position);

        const lerpFactor = 1.0 - Math.pow(0.01, delta); // Smooth camera movement

        this.camera.position.lerp(idealOffset, lerpFactor);
        this.orbitControls.target.lerp(idealLookat, lerpFactor);
        this.orbitControls.update();
    }
}