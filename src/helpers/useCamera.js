import { useEffect, useRef } from 'react';

export function useCamera() {
    const videoRef = useRef(null);

    useEffect(() => {
        let cancelled = false;
        let stream;
        navigator.mediaDevices
            .getUserMedia({ video:{ width: 1280, height: 720 } })
            .then(s => {
                if (cancelled) return s.getTracks().forEach(t => t.stop());
                stream = s;
                videoRef.current.srcObject = s;
                videoRef.current.play().catch(console.error)
            }).catch(err => console.error(err.name, err.message));
        return () => {
            cancelled = true;
            stream?.getTracks().forEach(t => t.stop());
        };
    }, []);

    return videoRef;
}
