import cv from "@techstark/opencv-js";

let ready;

export function loadCv() {
    ready ??= new Promise(async (resolve) => {
        let c = await cv;   
        if (c.Mat) return resolve(c);                    
        c.onRuntimeInitialized = () => resolve(c);
    });
    return ready;
}