import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
import { UserProfile } from '../types';
import { toast } from 'sonner';
import { handleFirestoreError, OperationType } from './firestoreErrorHandler';

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  isGuest: boolean;
  login: () => Promise<void>;
  loginAsGuest: () => void;
  logout: () => Promise<void>;
  updateProfile: (data: Partial<UserProfile>) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isGuest, setIsGuest] = useState(false);

  useEffect(() => {
    // Check if guest mode was active
    const savedGuest = localStorage.getItem('isGuestMode');
    if (savedGuest === 'true') {
      setIsGuest(true);
      setUser({ uid: 'guest-user', displayName: '访客用户', email: 'guest@local' } as any);
      setProfile({
        uid: 'guest-user',
        displayName: '访客用户',
        email: 'guest@local',
        createdAt: new Date().toISOString()
      });
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        // Fetch or create profile
        const userDoc = doc(db, 'users', firebaseUser.uid);
        try {
          const docSnap = await getDoc(userDoc);
          
          if (docSnap.exists()) {
            setProfile(docSnap.data() as UserProfile);
          } else {
            const newProfile: UserProfile = {
              uid: firebaseUser.uid,
              email: firebaseUser.email || '',
              displayName: firebaseUser.displayName || '',
              createdAt: new Date().toISOString()
            };
            await setDoc(userDoc, newProfile);
            setProfile(newProfile);
          }

          // Listen for profile changes
          onSnapshot(userDoc, (snap) => {
            if (snap.exists()) {
              setProfile(snap.data() as UserProfile);
            }
          }, (error) => {
            handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
          });
        } catch (error) {
          console.error("Error fetching user profile:", error);
          handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const login = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    try {
      const provider = new GoogleAuthProvider();
      // Force account selection to avoid some popup issues
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      console.error("Login error details:", error);
      const errorCode = error.code;
      const errorMessage = error.message;
      
      if (errorCode === 'auth/popup-blocked') {
        toast.error('登录窗口被浏览器拦截，请允许弹出窗口后重试。');
      } else if (errorCode === 'auth/cancelled-popup-request') {
        console.log('Popup request cancelled');
      } else if (errorCode === 'auth/popup-closed-by-user') {
        toast.info('登录窗口已关闭');
      } else if (errorCode === 'auth/unauthorized-domain') {
        toast.error('当前域名未在 Firebase 中授权。请尝试使用“访客模式”或联系开发者。');
      } else if (errorCode === 'auth/operation-not-allowed') {
        toast.error('Google 登录未在 Firebase 控制台中启用。');
      } else {
        toast.error(`登录失败 (${errorCode}): ${errorMessage || '未知错误'}`);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const loginAsGuest = () => {
    setIsGuest(true);
    localStorage.setItem('isGuestMode', 'true');
    const guestUser = { uid: 'guest-user', displayName: '访客用户', email: 'guest@local' } as any;
    setUser(guestUser);
    setProfile({
      uid: 'guest-user',
      displayName: '访客用户',
      email: 'guest@local',
      createdAt: new Date().toISOString()
    });
  };

  const logout = async () => {
    try {
      if (isGuest) {
        setIsGuest(false);
        localStorage.removeItem('isGuestMode');
        setUser(null);
        setProfile(null);
      } else {
        await signOut(auth);
      }
    } catch (error: any) {
      toast.error('退出失败: ' + error.message);
    }
  };

  const updateProfile = async (data: Partial<UserProfile>) => {
    if (!user) return;
    if (isGuest) {
      setProfile(prev => prev ? { ...prev, ...data } : null);
      return;
    }
    const userDoc = doc(db, 'users', user.uid);
    try {
      await setDoc(userDoc, data, { merge: true });
    } catch (error: any) {
      toast.error('更新个人资料失败: ' + error.message);
    }
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, isGuest, login, loginAsGuest, logout, updateProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
