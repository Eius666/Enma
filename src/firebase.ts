import { getFirestore } from 'firebase/firestore';
import { app, auth } from './firebaseApp';

export { auth };
export const db = getFirestore(app);

export default app;
