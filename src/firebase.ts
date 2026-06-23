import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { getFirestore, collection, addDoc, query, orderBy, getDocs, where } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, (firebaseConfig as any).firestoreDatabaseId || "(default)");

let cachedAccessToken: string | null = null;

export const getAccessToken = async (): Promise<string | null> => {
  if (!cachedAccessToken) {
    cachedAccessToken = localStorage.getItem('google_access_token');
  }
  return cachedAccessToken;
};

export const loginWithGoogle = async () => {
  const provider = new GoogleAuthProvider();
  
  try {
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (credential?.accessToken) {
      cachedAccessToken = credential.accessToken;
      localStorage.setItem('google_access_token', credential.accessToken);
    }
    return result;
  } catch (error: any) {
    if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
      console.log('Sign in popup was closed or cancelled.');
      return null;
    }
    console.error('Sign in error:', error);
    throw error;
  }
};

export const logout = async () => {
  cachedAccessToken = null;
  localStorage.removeItem('google_access_token');
  return signOut(auth);
};

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}
function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export const saveHistory = async (userId: string, agentMessage: string) => {
  try {
    await addDoc(collection(db, "chat_history"), {
      userId,
      agentMessage,
      timestamp: new Date()
    });
  } catch (e) {
    handleFirestoreError(e, OperationType.CREATE, "chat_history");
  }
};

export const getHistory = async (userId: string) => {
  try {
    const q = query(
      collection(db, "chat_history"), 
      where("userId", "==", userId)
    );
    const querySnapshot = await getDocs(q);
    const docs = querySnapshot.docs.map(doc => doc.data());
    
    // Sort client-side to completely prevent missing composite index errors on custom orders
    docs.sort((a: any, b: any) => {
      const timeValSecsA = a.timestamp?.seconds || (a.timestamp ? new Date(a.timestamp).getTime() / 1000 : 0);
      const timeValSecsB = b.timestamp?.seconds || (b.timestamp ? new Date(b.timestamp).getTime() / 1000 : 0);
      return timeValSecsB - timeValSecsA; // newest first
    });
    
    return docs;
  } catch (e) {
    handleFirestoreError(e, OperationType.LIST, "chat_history");
    return [];
  }
};
