import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Mic, 
  MicOff, 
  History, 
  Settings, 
  User, 
  LogOut, 
  Play, 
  Square, 
  Bookmark, 
  ChevronRight,
  Search,
  Volume2,
  BrainCircuit,
  Clock,
  CheckCircle2,
  AlertCircle,
  Pause,
  Trash2
} from 'lucide-react';
import { useAuth } from './lib/AuthContext';
import { db } from './lib/firebase';
import { collection, query, where, orderBy, onSnapshot, addDoc, updateDoc, doc, deleteDoc } from 'firebase/firestore';
import { AudioRecord, TranscriptItem, UserProfile } from './types';
import { analyzeAudioContent } from './services/geminiService';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { cn } from './lib/utils';
import { toast } from 'sonner';
import { handleFirestoreError, OperationType } from './lib/firestoreErrorHandler';

export default function App() {
  const { user, profile, loading, isGuest, login, loginAsGuest, logout } = useAuth();
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isMarked, setIsMarked] = useState(false);
  const [records, setRecords] = useState<AudioRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<AudioRecord | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'home' | 'history' | 'settings'>('home');
  const [currentTranscript, setCurrentTranscript] = useState<TranscriptItem[]>([]);
  const [interimText, setInterimText] = useState('');
  const [volume, setVolume] = useState(0);
  const transcriptRef = useRef<TranscriptItem[]>([]);
  const [isCollectingVoice, setIsCollectingVoice] = useState(false);
  const [autoListeningEnabled, setAutoListeningEnabled] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const currentRecordIdRef = useRef<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  // Auto listen / auto pause controls
  const autoListeningRef = useRef(false);
  const autoStreamRef = useRef<MediaStream | null>(null);
  const autoAudioContextRef = useRef<AudioContext | null>(null);
  const autoAnalyserRef = useRef<AnalyserNode | null>(null);
  const autoFrameRef = useRef<number | null>(null);
  const lastVoiceTimeRef = useRef<number>(Date.now());
  const VOICE_THRESHOLD = 12; // 0-255 average
  const SILENCE_TIMEOUT_MS = 1500;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      // stop auto listening resources
      stopAutoListening();
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  // Check browser compatibility
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition not supported in this browser');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.warn('getUserMedia not supported in this browser');
    }
  }, []);

  // Start auto listening after login
  useEffect(() => {
    if (!user || !autoListeningEnabled) return;
    startAutoListening();
    return () => stopAutoListening();
  }, [user, autoListeningEnabled]);

  const startAutoListening = async () => {
    if (autoListeningRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      autoStreamRef.current = stream;
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.fftSize = 256;
      autoAudioContextRef.current = audioContext;
      autoAnalyserRef.current = analyser;
      autoListeningRef.current = true;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const tick = () => {
        if (!autoAnalyserRef.current) return;
        autoAnalyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const average = sum / bufferLength;

        const now = Date.now();
        if (average > VOICE_THRESHOLD) {
          lastVoiceTimeRef.current = now;
          if (!isRecording) {
            startRecording(false);
          } else if (mediaRecorderRef.current?.state === 'paused') {
            resumeRecording();
          }
        } else {
          if (isRecording && mediaRecorderRef.current?.state === 'recording') {
            if (now - lastVoiceTimeRef.current > SILENCE_TIMEOUT_MS) {
              pauseRecording();
            }
          }
        }

        autoFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.error('Auto listening failed:', e);
      toast.error('自动监听启动失败，无法获取麦克风权限');
    }
  };

  const stopAutoListening = () => {
    autoListeningRef.current = false;
    if (autoFrameRef.current) {
      cancelAnimationFrame(autoFrameRef.current);
      autoFrameRef.current = null;
    }
    if (autoAudioContextRef.current) {
      autoAudioContextRef.current.close();
      autoAudioContextRef.current = null;
    }
    if (autoStreamRef.current) {
      autoStreamRef.current.getTracks().forEach(t => t.stop());
      autoStreamRef.current = null;
    }
    autoAnalyserRef.current = null;
  };

  // Fetch records
  useEffect(() => {
    if (!user) return;
    
    if (isGuest) {
      const savedRecords = localStorage.getItem('guest_records');
      if (savedRecords) {
        setRecords(JSON.parse(savedRecords));
      }
      return;
    }

    const q = query(
      collection(db, 'records'),
      where('userId', '==', user.uid),
      orderBy('startTime', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() } as AudioRecord));
      setRecords(docs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'records');
    });
    return () => unsubscribe();
  }, [user]);

  const startRecording = async (manual = true) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('Microphone stream acquired:', stream.getAudioTracks().map(t => t.label));
      
      // Audio analysis for visualizer
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.fftSize = 256;
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      const updateVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        setVolume(average);
        animationFrameRef.current = requestAnimationFrame(updateVolume);
      };
      updateVolume();

      // Check for supported MIME types
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') 
        ? 'audio/webm' 
        : MediaRecorder.isTypeSupported('audio/mp4') 
          ? 'audio/mp4' 
          : '';
      
      const mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      console.log('MediaRecorder initialized with mimeType:', mediaRecorder.mimeType);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          console.log('Audio data available:', e.data.size);
        }
      };

      mediaRecorder.onerror = (event: any) => {
        console.error('MediaRecorder error:', event.error);
        toast.error('录音过程发生错误');
      };

      mediaRecorder.onstop = async () => {
        try {
          if (recognitionRef.current) {
            recognitionRef.current.stop();
            recognitionRef.current = null;
          }
          
          // Stop audio analysis
          if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
          }
          if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
          }
          analyserRef.current = null;
          setVolume(0);

          if (currentRecordIdRef.current) {
            if (isGuest) {
              const analysis = await analyzeAudioContent(transcriptRef.current);
              const updatedRecords: AudioRecord[] = records.map(r => 
                r.id === currentRecordIdRef.current 
                  ? { ...r, ...analysis, status: 'completed' as const, endTime: new Date().toISOString() } 
                  : r
              );
              setRecords(updatedRecords);
              localStorage.setItem('guest_records', JSON.stringify(updatedRecords));
            } else {
              const recordDoc = doc(db, 'records', currentRecordIdRef.current);
              await updateDoc(recordDoc, {
                status: 'processing',
                endTime: new Date().toISOString()
              }).catch(err => handleFirestoreError(err, OperationType.UPDATE, `records/${currentRecordIdRef.current}`));
              
              // Trigger AI Analysis using the ref value
              const analysis = await analyzeAudioContent(transcriptRef.current);
              await updateDoc(recordDoc, {
                ...analysis,
                status: 'completed'
              }).catch(err => handleFirestoreError(err, OperationType.UPDATE, `records/${currentRecordIdRef.current}`));
            }
            toast.success('记录已完成并分析');
          }
        } catch (error) {
          console.error("Error in onstop:", error);
          toast.error('保存记录时出错');
        } finally {
          setIsRecording(false);
          setIsPaused(false);
          setIsMarked(false);
          setCurrentTranscript([]);
          transcriptRef.current = [];
          setInterimText('');
          currentRecordIdRef.current = null;
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        }
      };

      mediaRecorder.onstart = () => console.log('MediaRecorder started');
      mediaRecorder.onpause = () => {
        console.log('MediaRecorder paused');
        setIsPaused(true);
      };
      mediaRecorder.onresume = () => {
        console.log('MediaRecorder resumed');
        setIsPaused(false);
      };

      const recordData = {
        userId: user!.uid,
        title: `记录 ${format(new Date(), 'yyyy-MM-dd HH:mm')}`,
        startTime: new Date().toISOString(),
        transcript: [],
        isHighPriority: manual,
        status: 'recording' as const
      };

      let recordId = '';
      if (isGuest) {
        recordId = `local_${Date.now()}`;
        const newRecord = { id: recordId, ...recordData };
        const updatedRecords = [newRecord, ...records];
        setRecords(updatedRecords);
        localStorage.setItem('guest_records', JSON.stringify(updatedRecords));
      } else {
        const docRef = await addDoc(collection(db, 'records'), recordData)
          .catch(err => {
            handleFirestoreError(err, OperationType.CREATE, 'records');
            throw err;
          });
        recordId = docRef.id;
      }
      currentRecordIdRef.current = recordId;
      
      mediaRecorder.start();
      setIsRecording(true);
      if (manual) toast.info('开始手动录音');

      // Real-time transcription using Web Speech API
      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'zh-CN';

        recognition.onresult = (event: any) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              const text = event.results[i][0].transcript.trim();
              console.log('Final speech result:', text);
              if (text) {
                const newPart: TranscriptItem = {
                  speaker: 'me',
                  text: text,
                  timestamp: Date.now()
                };
                
                transcriptRef.current = [...transcriptRef.current, newPart];
                setCurrentTranscript([...transcriptRef.current]);
                setInterimText(''); // Clear interim when a final result comes in

                if (currentRecordIdRef.current) {
                  if (isGuest) {
                    const updatedRecords = records.map(r => 
                      r.id === currentRecordIdRef.current 
                        ? { ...r, transcript: transcriptRef.current } 
                        : r
                    );
                    setRecords(updatedRecords);
                    localStorage.setItem('guest_records', JSON.stringify(updatedRecords));
                  } else {
                    updateDoc(doc(db, 'records', currentRecordIdRef.current), {
                      transcript: transcriptRef.current
                    }).catch(err => handleFirestoreError(err, OperationType.UPDATE, `records/${currentRecordIdRef.current}`));
                  }
                }
              }
            } else {
              interim += event.results[i][0].transcript;
            }
          }
          if (interim) {
            console.log('Interim speech result:', interim);
            setInterimText(interim);
          }
        };

        recognition.onstart = () => console.log('Speech recognition service has started');
        recognition.onspeechstart = () => console.log('Speech has been detected');
        recognition.onnomatch = () => console.log('Speech not recognized');

        recognition.onerror = (event: any) => {
          console.error('Speech recognition error:', event.error, event.message);
          if (event.error === 'not-allowed') {
            toast.error('语音识别权限被拒绝，请检查浏览器设置');
          } else if (event.error === 'network') {
            toast.error('语音识别网络连接失败');
          } else if (event.error === 'no-speech') {
            console.log('No speech detected for a while');
          } else {
            toast.error(`语音识别错误: ${event.error}`);
          }
        };

        recognition.onend = () => {
          console.log('Speech recognition ended');
          // Restart if still recording and NOT paused
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording' && recognitionRef.current) {
            try {
              recognition.start();
              console.log('Speech recognition restarted');
            } catch (e) {
              console.error('Failed to restart recognition:', e);
            }
          }
        };

        try {
          recognition.start();
          recognitionRef.current = recognition;
          console.log('Speech recognition started');
        } catch (e) {
          console.error('Failed to start recognition:', e);
          toast.error('语音识别启动失败');
        }
      } else {
        console.error('SpeechRecognition not supported in this browser');
        toast.error('您的浏览器不支持实时语音转写，请尝试使用 Chrome 浏览器。');
      }

    } catch (err) {
      console.error(err);
      toast.error('无法开启麦克风');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
    }
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    }
  };

  const resumeRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      if (recognitionRef.current) {
        try {
          recognitionRef.current.start();
        } catch (e) {
          console.error('Failed to resume recognition:', e);
        }
      }
    }
  };

  const deleteRecord = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setRecordToDelete(id);
  };

  const confirmDelete = async () => {
    if (!recordToDelete) return;
    try {
      if (isGuest) {
        const updatedRecords = records.filter(r => r.id !== recordToDelete);
        setRecords(updatedRecords);
        localStorage.setItem('guest_records', JSON.stringify(updatedRecords));
      } else {
        await deleteDoc(doc(db, 'records', recordToDelete));
      }
      toast.success('记录已删除');
      setRecordToDelete(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `records/${recordToDelete}`);
    }
  };

  const toggleMark = () => {
    const newMarked = !isMarked;
    setIsMarked(newMarked);
    if (currentRecordIdRef.current) {
      if (isGuest) {
        const updatedRecords = records.map(r => 
          r.id === currentRecordIdRef.current 
            ? { ...r, isHighPriority: newMarked } 
            : r
        );
        setRecords(updatedRecords);
        localStorage.setItem('guest_records', JSON.stringify(updatedRecords));
      } else {
        updateDoc(doc(db, 'records', currentRecordIdRef.current), {
          isHighPriority: newMarked
        }).catch(err => handleFirestoreError(err, OperationType.UPDATE, `records/${currentRecordIdRef.current}`));
      }
    }
  };

  const updateProfile = async (data: Partial<UserProfile>) => {
    if (!user) return;
    const userDoc = doc(db, 'users', user.uid);
    try {
      await updateDoc(userDoc, data);
    } catch (error: any) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
    }
  };

  const startVoiceCollection = () => {
    setIsCollectingVoice(true);
    toast.info('正在采集声纹，请随意说几句话...');
    setTimeout(() => {
      setIsCollectingVoice(false);
      toast.success('声纹采集成功！系统已记住您的声音。');
    }, 5000);
  };

  if (loading) return (
    <div className="h-screen w-full flex items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-500 font-medium">加载中...</p>
      </div>
    </div>
  );

  if (!user) return (
    <div className="h-screen w-full flex items-center justify-center bg-slate-50 p-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-md w-full mac-card p-10 text-center space-y-8"
      >
        <div className="w-20 h-20 bg-slate-900 rounded-2xl mx-auto flex items-center justify-center shadow-lg">
          <Volume2 className="w-10 h-10 text-white" />
        </div>
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">声印</h1>
          <p className="text-slate-500">捕捉每一个重要时刻</p>
        </div>
        <div className="space-y-3">
          <button 
            onClick={login}
            className="w-full py-4 bg-slate-900 text-white rounded-xl font-semibold hover:bg-slate-800 transition-all flex items-center justify-center gap-3 active:scale-95 shadow-md"
          >
            <User className="w-5 h-5" />
            使用 Google 账号登录
          </button>
          <button 
            onClick={loginAsGuest}
            className="w-full py-4 bg-white border border-slate-200 text-slate-600 rounded-xl font-semibold hover:bg-slate-50 transition-all flex items-center justify-center gap-3 active:scale-95"
          >
            <Play className="w-5 h-5" />
            以访客身份继续 (仅本地存储)
          </button>
        </div>
      </motion.div>
    </div>
  );

  return (
    <div className="h-screen w-full bg-slate-200 flex items-center justify-center p-4 overflow-hidden font-sans">
      <div className="w-full h-full max-w-[177.78vh] max-h-[56.25vw] aspect-video bg-white text-slate-900 shadow-2xl rounded-2xl overflow-hidden flex border border-slate-300/50">
        {/* macOS Sidebar - 20% width */}
        <aside className="w-[20%] min-w-[200px] mac-sidebar flex flex-col">
        <div className="p-6 flex items-center gap-3">
          <div className="w-8 h-8 bg-slate-900 rounded-lg flex items-center justify-center shadow-sm">
            <Volume2 className="w-5 h-5 text-white" />
          </div>
          <h1 className="font-bold text-lg tracking-tight">声印</h1>
        </div>

        <nav className="flex-1 px-3 space-y-1">
          <button 
            onClick={() => setActiveTab('home')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              activeTab === 'home' ? "bg-slate-200/60 text-slate-900" : "text-slate-500 hover:bg-slate-200/40 hover:text-slate-900"
            )}
          >
            <Mic className="w-4 h-4" />
            实时记录
          </button>
          <button 
            onClick={() => setActiveTab('history')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              activeTab === 'history' ? "bg-slate-200/60 text-slate-900" : "text-slate-500 hover:bg-slate-200/40 hover:text-slate-900"
            )}
          >
            <History className="w-4 h-4" />
            对话回顾
          </button>
          <button 
            onClick={() => setActiveTab('settings')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
              activeTab === 'settings' ? "bg-slate-200/60 text-slate-900" : "text-slate-500 hover:bg-slate-200/40 hover:text-slate-900"
            )}
          >
            <Settings className="w-4 h-4" />
            偏好设置
          </button>
        </nav>

        <div className="p-4 border-t border-slate-200/60">
          <div className="flex items-center gap-3 px-2 py-3">
            <div className="w-8 h-8 rounded-full bg-slate-200 overflow-hidden">
              {user.photoURL ? (
                <img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              ) : (
                <User className="w-full h-full p-1.5 text-slate-400" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{user.displayName}</p>
              <p className="text-[10px] text-slate-400 truncate">{user.email}</p>
            </div>
            <button onClick={logout} className="p-1.5 text-slate-400 hover:text-red-500 transition-colors">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Area - 80% width */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-50/50 overflow-hidden">
        {activeTab === 'home' && (
          <div className="flex-1 flex flex-col p-6 max-w-5xl mx-auto w-full space-y-6 overflow-hidden">
            <header className="flex justify-between items-end shrink-0">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">实时记录</h2>
                <p className="text-xs text-slate-500 mt-0.5">捕捉当下的每一段精彩对话</p>
              </div>
              <div className="flex items-center gap-4">
                {isRecording && (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-600 rounded-full text-xs font-bold recording-pulse">
                    <div className="w-2 h-2 bg-red-600 rounded-full" />
                    REC
                  </div>
                )}
              </div>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0 overflow-hidden">
              {/* Recording Controls */}
              <div className="lg:col-span-1 space-y-4 overflow-y-auto pr-1">
                <div className="mac-card p-6 flex flex-col items-center justify-center text-center space-y-4">
                  <div className={cn(
                    "w-24 h-24 rounded-full flex items-center justify-center transition-all duration-500 shadow-inner relative overflow-hidden",
                    isRecording ? "bg-red-500 scale-110 shadow-red-200" : "bg-slate-100"
                  )}>
                    {isRecording && (
                      <motion.div 
                        className="absolute inset-0 bg-red-400 opacity-30"
                        animate={{ 
                          scale: 1 + (volume / 100),
                          opacity: 0.1 + (volume / 200)
                        }}
                        transition={{ type: "spring", stiffness: 300, damping: 20 }}
                      />
                    )}
                    {isRecording ? (
                      <Mic className="w-10 h-10 text-white relative z-10" />
                    ) : (
                      <MicOff className="w-10 h-10 text-slate-400 relative z-10" />
                    )}
                  </div>
                  
                  {isRecording && (
                    <div className="flex gap-1 h-8 items-center justify-center w-full">
                      {[...Array(12)].map((_, i) => (
                        <motion.div
                          key={i}
                          className="w-1 bg-red-500 rounded-full"
                          animate={{ 
                            height: Math.max(4, (volume * (0.5 + Math.random() * 0.5)) * (1 - Math.abs(i - 5.5) / 6))
                          }}
                          transition={{ type: "spring", stiffness: 300, damping: 20 }}
                        />
                      ))}
                    </div>
                  )}
                  
                  <div className="space-y-1">
                    <h3 className="font-bold text-base">{isRecording ? '正在倾听...' : '准备就绪'}</h3>
                    <p className="text-[11px] text-slate-500 leading-tight">
                      {isRecording ? '系统正在实时转写并分析内容' : '点击下方按钮开始一段新的记录'}
                    </p>
                  </div>

                  <div className="flex w-full gap-2">
                    <button 
                      onClick={() => isRecording ? stopRecording() : startRecording()}
                      className={cn(
                        "flex-1 py-3 rounded-lg font-bold text-sm transition-all flex items-center justify-center gap-2 shadow-sm",
                        isRecording 
                          ? "bg-white border border-slate-200 text-slate-900 hover:bg-slate-50" 
                          : "bg-slate-900 text-white hover:bg-slate-800"
                      )}
                    >
                      {isRecording ? <Square className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                      {isRecording ? '停止记录' : '开始记录'}
                    </button>
                    
                    {isRecording && (
                      <button 
                        onClick={() => isPaused ? resumeRecording() : pauseRecording()}
                        className="p-3 mac-card hover:bg-slate-50 transition-all flex items-center justify-center"
                        title={isPaused ? "继续录音" : "暂停录音"}
                      >
                        {isPaused ? <Play className="w-4 h-4 text-brand-500" /> : <Pause className="w-4 h-4 text-slate-600" />}
                      </button>
                    )}
                  </div>

                  {isRecording && (
                    <button 
                      onClick={toggleMark}
                      className={cn(
                        "w-full py-3 rounded-xl text-sm font-medium transition-all flex items-center justify-center gap-2",
                        isMarked ? "bg-amber-50 text-amber-600 border border-amber-100" : "bg-slate-50 text-slate-500 hover:bg-slate-100"
                      )}
                    >
                      <Bookmark className={cn("w-4 h-4", isMarked && "fill-current")} />
                      {isMarked ? '已标记为重点' : '标记为重点'}
                    </button>
                  )}
                </div>
              </div>

              {/* Real-time Transcript */}
              <div className="lg:col-span-2 flex flex-col min-h-0">
                <div className="mac-card flex-1 flex flex-col overflow-hidden">
                  <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">实时转写内容</span>
                    <span className="text-[10px] text-slate-400">AI 正在实时处理...</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {currentTranscript.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-slate-300 space-y-4">
                        <History className="w-12 h-12 opacity-20" />
                        <p className="text-sm">暂无内容，开始记录后将在此显示转写</p>
                      </div>
                    ) : (
                      currentTranscript.map((item, idx) => (
                        <motion.div 
                          key={idx}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="space-y-1"
                        >
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-[10px] font-bold px-1.5 py-0.5 rounded uppercase",
                              item.speaker === 'me' ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600"
                            )}>
                              {item.speaker === 'me' ? '我' : '他人'}
                            </span>
                            <span className="text-[10px] text-slate-400">{format(item.timestamp, 'HH:mm:ss')}</span>
                          </div>
                          <p className="text-slate-700 leading-relaxed">{item.text}</p>
                        </motion.div>
                      ))
                    )}
                    {interimText && (
                      <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.7 }}
                        className="space-y-1"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase bg-slate-100 text-slate-400">
                            正在输入...
                          </span>
                        </div>
                        <p className="text-slate-500 italic leading-relaxed">{interimText}</p>
                      </motion.div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div className="flex-1 flex flex-col p-6 max-w-5xl mx-auto w-full space-y-6 overflow-hidden">
            <header className="flex justify-between items-end shrink-0">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">对话回顾</h2>
                <p className="text-xs text-slate-500 mt-0.5">回顾并搜索您过去的所有记录</p>
              </div>
              <div className="relative">
                <Search className="w-3 h-3 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input 
                  type="text" 
                  placeholder="搜索内容..." 
                  className="mac-input pl-8 w-48 py-1.5 text-xs"
                />
              </div>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 overflow-y-auto pr-1">
              {records.map(record => (
                <motion.div 
                  key={record.id}
                  layoutId={record.id}
                  onClick={() => setSelectedRecord(record)}
                  className="mac-card p-5 hover:border-brand-500/50 hover:shadow-md transition-all cursor-pointer group"
                >
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-2">
                      <div className={cn(
                        "p-2 rounded-lg",
                        record.isHighPriority ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-500"
                      )}>
                        {record.isHighPriority ? <Bookmark className="w-4 h-4 fill-current" /> : <Clock className="w-4 h-4" />}
                      </div>
                      <div>
                        <h4 className="font-bold text-slate-900 group-hover:text-brand-600 transition-colors">{record.title}</h4>
                        <p className="text-[10px] text-slate-400">
                          {format(new Date(record.startTime), 'yyyy年MM月dd日 HH:mm', { locale: zhCN })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={(e) => deleteRecord(record.id, e)}
                        className="p-1.5 hover:bg-red-50 text-slate-300 hover:text-red-500 rounded-lg transition-all"
                        title="删除记录"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-slate-500 transition-all" />
                    </div>
                  </div>
                  <p className="text-sm text-slate-600 line-clamp-2 mb-4 leading-relaxed">
                    {record.summary || '正在生成总结...'}
                  </p>
                  <div className="flex items-center justify-between pt-4 border-t border-slate-50">
                    <div className="flex gap-1">
                      {record.status === 'completed' ? (
                        <span className="text-[10px] bg-green-50 text-green-600 px-2 py-0.5 rounded-full font-medium">已分析</span>
                      ) : (
                        <span className="text-[10px] bg-brand-50 text-brand-600 px-2 py-0.5 rounded-full font-medium animate-pulse">处理中</span>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-400">
                      {record.transcript.length} 条对话
                    </span>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="flex-1 flex flex-col p-6 max-w-3xl mx-auto w-full space-y-6 overflow-y-auto">
            <header className="shrink-0">
              <h2 className="text-2xl font-bold tracking-tight">偏好设置</h2>
              <p className="text-xs text-slate-500 mt-0.5">个性化您的智能记录体验</p>
            </header>

            <div className="space-y-4">
              <section className="mac-card p-5 space-y-3">
                <h3 className="font-bold text-sm flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-brand-500" />
                  自动监听
                </h3>
                <p className="text-xs text-slate-500">开启后将自动检测人声并自动录音/静音暂停。</p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setAutoListeningEnabled(v => !v)}
                    className={cn(
                      "mac-button-secondary py-1.5 text-xs",
                      autoListeningEnabled && "text-brand-500 border-brand-200 bg-brand-50"
                    )}
                  >
                    {autoListeningEnabled ? '已开启' : '已关闭'}
                  </button>
                  <span className="text-[10px] text-slate-400">关闭后仅手动录音</span>
                </div>
              </section>

              <section className="mac-card p-5 space-y-3">
                <h3 className="font-bold text-sm flex items-center gap-2">
                  <User className="w-4 h-4 text-brand-500" />
                  我的声纹
                </h3>
                <p className="text-xs text-slate-500">采集您的声音样本，以便系统能够准确区分“我”与“他人”。</p>
                <button 
                  onClick={startVoiceCollection}
                  disabled={isCollectingVoice}
                  className={cn(
                    "mac-button-secondary py-1.5 text-xs flex items-center gap-2",
                    isCollectingVoice && "text-brand-500 border-brand-200 bg-brand-50"
                  )}
                >
                  {isCollectingVoice && <div className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />}
                  {isCollectingVoice ? '正在采集...' : '开始采集'}
                </button>
              </section>

              <section className="mac-card p-5 space-y-3">
                <h3 className="font-bold text-sm flex items-center gap-2 text-red-600">
                  <AlertCircle className="w-4 h-4" />
                  危险区域
                </h3>
                <p className="text-xs text-slate-500">退出当前账号或清除所有本地缓存数据。</p>
                <div className="flex gap-3">
                  <button onClick={logout} className="mac-button-secondary py-1.5 text-xs text-red-600 border-red-100 hover:bg-red-50">
                    退出登录
                  </button>
                </div>
              </section>
            </div>
          </div>
        )}
      </main>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {recordToDelete && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setRecordToDelete(null)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="relative w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6 space-y-6"
            >
              <div className="space-y-2">
                <h3 className="text-lg font-bold">确认删除</h3>
                <p className="text-sm text-slate-500">您确定要永久删除这条记录吗？此操作无法撤销。</p>
              </div>
              <div className="flex gap-3">
                <button 
                  onClick={() => setRecordToDelete(null)}
                  className="flex-1 mac-button-secondary"
                >
                  取消
                </button>
                <button 
                  onClick={confirmDelete}
                  className="flex-1 py-2.5 bg-red-500 text-white rounded-xl font-bold text-sm hover:bg-red-600 transition-all shadow-sm"
                >
                  确认删除
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Record Detail Modal */}
      <AnimatePresence>
        {selectedRecord && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedRecord(null)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-2xl max-h-[90vh] bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="p-8 border-b border-slate-100 flex justify-between items-start bg-slate-50/30">
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="text-2xl font-bold">{selectedRecord.title}</h3>
                    {selectedRecord.isHighPriority && (
                      <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-[10px] font-bold rounded uppercase">重点</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 flex items-center gap-2">
                    <Clock className="w-3 h-3" />
                    {format(new Date(selectedRecord.startTime), 'yyyy年MM月dd日 HH:mm', { locale: zhCN })}
                  </p>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-8 space-y-8">
                <section className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <BrainCircuit className="w-4 h-4 text-brand-500" />
                    AI 智能总结
                  </h4>
                  <div className="p-5 bg-brand-50/50 rounded-2xl border border-brand-100/50">
                    <p className="text-slate-800 leading-relaxed font-medium">
                      {selectedRecord.summary || '正在生成总结...'}
                    </p>
                  </div>
                </section>

                <section className="space-y-3">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    深度复盘分析
                  </h4>
                  <div className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                    <p className="text-slate-600 text-sm leading-relaxed whitespace-pre-wrap">
                      {selectedRecord.analysis || '正在进行深度分析...'}
                    </p>
                  </div>
                </section>

                <section className="space-y-4">
                  <h4 className="text-xs font-bold text-slate-400 uppercase tracking-widest">完整对话转写</h4>
                  <div className="space-y-6">
                    {selectedRecord.transcript.map((item, idx) => (
                      <div key={idx} className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-[10px] font-bold px-1.5 py-0.5 rounded uppercase",
                            item.speaker === 'me' ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-600"
                          )}>
                            {item.speaker === 'me' ? '我' : '他人'}
                          </span>
                          <span className="text-[10px] text-slate-400">{format(item.timestamp, 'HH:mm:ss')}</span>
                        </div>
                        <p className="text-slate-700 leading-relaxed">{item.text}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>

              <div className="p-6 bg-slate-50 border-t border-slate-100 flex justify-end">
                <button 
                  onClick={() => setSelectedRecord(null)}
                  className="mac-button-primary"
                >
                  关闭详情
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
    </div>
  );
}
