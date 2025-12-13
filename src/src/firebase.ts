import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDTz247Bx6KpADqBF96UvevLtWdF7sELlY",
  authDomain: "enma-4ea29.firebaseapp.com",    
  projectId: "enma-4ea29",    
  storageBucket: "enma-4ea29.firebasestorage.app",
  messagingSenderId: "282908052557", 
  appId: "1:282908052557:web:747866c87b247762b3a004"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);

export default app;
