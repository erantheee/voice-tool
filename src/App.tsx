import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Mic, 
  MicOff, 
  History, 
  Languages,
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
  Trash2,
  Users
} from 'lucide-react';
import { useAuth } from './lib/AuthContext';
import { db } from './lib/firebase';
import { collection, query, where, orderBy, onSnapshot, addDoc, updateDoc, doc, deleteDoc } from 'firebase/firestore';
import { AudioRecord, TranscriptItem, UserProfile, FollowedPerson } from './types';
import { analyzeAudioContent } from './services/geminiService';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import { cn } from './lib/utils';
import { toast } from 'sonner';
import { handleFirestoreError, OperationType } from './lib/firestoreErrorHandler';

export default function App() {
  const { user, profile, loading, isGuest, login, loginAsGuest, logout, updateProfile } = useAuth();
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isMarked, setIsMarked] = useState(false);
  const [records, setRecords] = useState<AudioRecord[]>([]);
  const [selectedRecord, setSelectedRecord] = useState<AudioRecord | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'home' | 'history' | 'settings'>('home');
  const [currentTranscript, setCurrentTranscript] = useState<TranscriptItem[]>([]);
  const [interimText, setInterimText] = useState('');
  const [recognitionLang, setRecognitionLang] = useState('zh-CN');
  const [volume, setVolume] = useState(0);
  const [isAddingPerson, setIsAddingPerson] = useState(false);
  const [newPersonName, setNewPersonName] = useState('');
  const transcriptRef = useRef<TranscriptItem[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [isCollectingVoice, setIsCollectingVoice] = useState(false);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const currentRecordIdRef = useRef<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentTranscript, interimText]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
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
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
          console.log('Audio data available:', e.data.size);
        }
      };

      mediaRecorder.onerror = (event: any) => {
        console.error('MediaRecorder error:', event.error);
        toast.error('录音过程发生错误');
      };

      mediaRecorder.onstop = async () => {
        const savingToast = toast.loading('正在保存并分析记录...');
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

          const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' });
          const reader = new FileReader();
          
          const getBase64 = (): Promise<string> => new Promise((resolve) => {
            reader.onloadend = () => {
              const base64String = (reader.result as string).split(',')[1];
              resolve(base64String);
            };
            reader.readAsDataURL(audioBlob);
          });

          const audioBase64 = await getBase64();

          if (currentRecordIdRef.current) {
            if (isGuest) {
              const result = await analyzeAudioContent(transcriptRef.current, audioBase64, audioBlob.type);
              const updatedRecords: AudioRecord[] = records.map(r => 
                r.id === currentRecordIdRef.current 
                  ? { 
                      ...r, 
                      summary: result.summary, 
                      analysis: result.analysis, 
                      transcript: result.refinedTranscript || r.transcript,
                      status: 'completed' as const, 
                      endTime: new Date().toISOString() 
                    } 
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
              
              // Trigger AI Analysis and Transcript Refinement
              const result = await analyzeAudioContent(transcriptRef.current, audioBase64, audioBlob.type);
              await updateDoc(recordDoc, {
                summary: result.summary,
                analysis: result.analysis,
                transcript: result.refinedTranscript || transcriptRef.current,
                status: 'completed'
              }).catch(err => handleFirestoreError(err, OperationType.UPDATE, `records/${currentRecordIdRef.current}`));
            }
            toast.dismiss(savingToast);
            toast.success('记录已完成并分析');
          }
        } catch (error) {
          console.error("Error in onstop:", error);
          toast.dismiss(savingToast);
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
        // Use user selected language for better accuracy
        recognition.lang = recognitionLang;
        
        // Optimize for speed and accuracy
        if ('maxAlternatives' in recognition) recognition.maxAlternatives = 1;

        recognition.onresult = (event: any) => {
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              const text = event.results[i][0].transcript.trim();
              console.log('Final speech result:', text);
              if (text) {
                // Speaker detection based on voice frequency
                let speaker: 'me' | 'other' | string = 'me';
                if (profile?.voiceFrequency && analyserRef.current) {
                  const bufferLength = analyserRef.current.frequencyBinCount;
                  const dataArray = new Uint8Array(bufferLength);
                  analyserRef.current.getByteFrequencyData(dataArray);
                  
                  let sum = 0;
                  let count = 0;
                  for (let j = 0; j < bufferLength; j++) {
                    if (dataArray[j] > 30) { // Threshold to ignore noise
                      sum += j;
                      count++;
                    }
                  }
                  const currentFreqIndex = count > 0 ? sum / count : 0;
                  
                  // Simple heuristic: if current frequency index is significantly different from profile
                  // we assume it's someone else.
                  const diff = Math.abs(currentFreqIndex - profile.voiceFrequency);
                  if (diff > 8) { 
                    speaker = 'other';
                    
                    // Check followed persons
                    if (profile.followedPersons && profile.followedPersons.length > 0) {
                      let bestMatch = null;
                      let minDiff = 8; // High confidence threshold
                      
                      for (const person of profile.followedPersons) {
                        if (person.voiceFrequency) {
                          const pDiff = Math.abs(currentFreqIndex - person.voiceFrequency);
                          if (pDiff < minDiff) {
                            minDiff = pDiff;
                            bestMatch = person.id;
                          }
                        }
                      }
                      if (bestMatch) speaker = bestMatch;
                    }
                  }
                }

                const newPart: TranscriptItem = {
                  speaker,
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

  const startVoiceCollection = async (personId?: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      analyser.fftSize = 2048;

      setIsCollectingVoice(true);
      const targetName = personId 
        ? profile?.followedPersons?.find(p => p.id === personId)?.name 
        : '您自己';
      toast.info(`正在采集 ${targetName} 的声纹，请持续说话 5 秒钟...`);

      const frequencies: number[] = [];
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const collectionInterval = setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < bufferLength; i++) {
          if (dataArray[i] > 30) { // Only count significant frequencies
            sum += i;
            count++;
          }
        }
        if (count > 0) {
          frequencies.push(sum / count);
        }
      }, 100);

      setTimeout(async () => {
        clearInterval(collectionInterval);
        setIsCollectingVoice(false);
        
        // Calculate average frequency index
        if (frequencies.length > 0) {
          const avgFreq = frequencies.reduce((a, b) => a + b, 0) / frequencies.length;
          
          if (personId) {
            const updatedPersons = profile?.followedPersons?.map(p => 
              p.id === personId ? { ...p, voiceFrequency: avgFreq, sampleCount: p.sampleCount + 1 } : p
            );
            await updateProfile({ followedPersons: updatedPersons });
            toast.success(`${targetName} 的声纹采集成功！`);
          } else {
            await updateProfile({ voiceFrequency: avgFreq });
            toast.success('您的声纹采集成功！系统已记住您的声音特征。');
          }
        } else {
          toast.error('未能采集到有效声音，请重试。');
        }

        // Cleanup
        stream.getTracks().forEach(track => track.stop());
        audioContext.close();
      }, 5000);

    } catch (err) {
      console.error('Voice collection failed:', err);
      toast.error('无法开启麦克风进行采集');
      setIsCollectingVoice(false);
    }
  };

  const addFollowedPerson = async () => {
    if (!newPersonName.trim()) return;
    if ((profile?.followedPersons?.length || 0) >= 4) {
      toast.error('最多只能关注 4 个人');
      return;
    }

    const newPerson: FollowedPerson = {
      id: `person_${Date.now()}`,
      name: newPersonName.trim(),
      sampleCount: 0
    };

    const updatedPersons = [...(profile?.followedPersons || []), newPerson];
    await updateProfile({ followedPersons: updatedPersons });
    setNewPersonName('');
    setIsAddingPerson(false);
    toast.success('关注人已添加');
  };

  const removeFollowedPerson = async (id: string) => {
    const updatedPersons = profile?.followedPersons?.filter(p => p.id !== id);
    await updateProfile({ followedPersons: updatedPersons });
    toast.success('关注人已移除');
  };

  const tagSpeakerInTranscript = async (recordId: string, itemIdx: number, speakerId: string) => {
    // This is a simplified version of "learning" - we use the AI to refine the transcript 
    // and potentially update the voice frequency if we had raw audio data.
    // For now, we just update the speaker in the transcript.
    
    const record = records.find(r => r.id === recordId);
    if (!record) return;

    const newTranscript = [...record.transcript];
    newTranscript[itemIdx] = { ...newTranscript[itemIdx], speaker: speakerId };

    if (isGuest) {
      const updatedRecords = records.map(r => r.id === recordId ? { ...r, transcript: newTranscript } : r);
      setRecords(updatedRecords);
      localStorage.setItem('guest_records', JSON.stringify(updatedRecords));
    } else {
      await updateDoc(doc(db, 'records', recordId), { transcript: newTranscript })
        .catch(err => handleFirestoreError(err, OperationType.UPDATE, `records/${recordId}`));
    }
    
    // If it's a followed person, we could also "learn" their frequency here if we had the raw data.
    // As a prototype, we'll just show a success message.
    toast.success('说话人标记已更新');
    
    // Update selectedRecord if it's the one being edited
    if (selectedRecord?.id === recordId) {
      setSelectedRecord({ ...selectedRecord, transcript: newTranscript });
    }
  };

  if (loading) {
    console.log('Auth is loading...');
    return (
      <div className="h-screen w-full flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-500 font-medium">加载中...</p>
        </div>
      </div>
    );
  }

  console.log('Auth state:', { hasUser: !!user, isGuest, userId: user?.uid });

  if (!user) {
    console.log('No user found, showing login screen');
    return (
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
  }

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
              <div className="lg:col-span-1 space-y-4 overflow-hidden no-scrollbar pr-1">
                <div className="mac-card p-6 flex flex-col items-center justify-center text-center space-y-6">
                  <div className="flex items-center gap-4">
                    {/* Main Recording Button */}
                    <button 
                      onClick={() => isRecording ? stopRecording() : startRecording()}
                      className={cn(
                        "w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 shadow-lg relative overflow-hidden active:scale-95 group",
                        isRecording ? "bg-red-500 shadow-red-200" : "bg-slate-900 shadow-slate-200"
                      )}
                    >
                      {isRecording && !isPaused && (
                        <motion.div 
                          className="absolute inset-0 bg-red-400 opacity-30"
                          animate={{ 
                            scale: [1, 1.2, 1],
                            opacity: [0.3, 0.1, 0.3]
                          }}
                          transition={{ duration: 2, repeat: Infinity }}
                        />
                      )}
                      
                      {/* Volume Ring */}
                      {isRecording && !isPaused && (
                        <motion.div 
                          className="absolute inset-0 border-4 border-white/30 rounded-full"
                          animate={{ 
                            scale: 1 + (volume / 100),
                            opacity: 0.1 + (volume / 200)
                          }}
                          transition={{ type: "spring", stiffness: 300, damping: 20 }}
                        />
                      )}

                      {isRecording ? (
                        <Square className="w-8 h-8 text-white relative z-10 fill-current" />
                      ) : (
                        <Mic className="w-8 h-8 text-white relative z-10" />
                      )}
                    </button>

                    {/* Pause Button */}
                    {isRecording && (
                      <motion.button 
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        onClick={() => isPaused ? resumeRecording() : pauseRecording()}
                        className="w-10 h-10 rounded-full bg-white border border-slate-200 shadow-sm flex items-center justify-center hover:bg-slate-50 transition-all active:scale-90 group"
                        title={isPaused ? "继续录音" : "暂停录音"}
                      >
                        {isPaused ? (
                          <Play className="w-4 h-4 text-brand-500 fill-current" />
                        ) : (
                          <Pause className="w-4 h-4 text-slate-600 fill-current" />
                        )}
                      </motion.button>
                    )}
                  </div>

                  {/* Mark Button */}
                  {isRecording && (
                    <motion.button 
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      onClick={toggleMark}
                      className={cn(
                        "px-4 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-2 shadow-sm border",
                        isMarked 
                          ? "bg-amber-50 text-amber-600 border-amber-200" 
                          : "bg-white text-slate-500 border-slate-100 hover:bg-slate-50"
                      )}
                    >
                      <Bookmark className={cn("w-3.5 h-3.5", isMarked && "fill-current")} />
                      {isMarked ? '已标记重点' : '标记重点'}
                    </motion.button>
                  )}
                  
                  <div className="space-y-0.5">
                    <h3 className="font-bold text-sm">
                      {!isRecording ? '准备就绪' : (isPaused ? '已暂停' : '')}
                    </h3>
                    <p className="text-[10px] text-slate-500 leading-tight">
                      {isRecording 
                        ? (isPaused ? '点击播放图标继续' : '') 
                        : '点击麦克风开始记录'}
                    </p>
                  </div>

                  {isRecording && !isPaused && (
                    <div className="flex gap-1 h-4 items-center justify-center w-full">
                      {[...Array(12)].map((_, i) => (
                        <motion.div
                          key={i}
                          className="w-0.5 bg-red-500 rounded-full"
                          animate={{ 
                            height: Math.max(3, (volume * (0.4 + Math.random() * 0.4)) * (1 - Math.abs(i - 5.5) / 6))
                          }}
                          transition={{ type: "spring", stiffness: 300, damping: 20 }}
                        />
                      ))}
                    </div>
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
                  <div className="flex-1 overflow-y-auto no-scrollbar p-6 space-y-6">
                    {currentTranscript.length === 0 ? (
                      <div className="h-full flex flex-col items-center justify-center text-slate-300 space-y-4">
                        <History className="w-12 h-12 opacity-20" />
                        <p className="text-sm">暂无内容，开始记录后将在此显示转写</p>
                      </div>
                    ) : (
                      currentTranscript.map((item, idx) => {
                        const speakerName = item.speaker === 'me' 
                          ? '我' 
                          : (profile?.followedPersons?.find(p => p.id === item.speaker)?.name || '他人');
                        
                        return (
                          <motion.div 
                            key={idx}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            className="space-y-1"
                          >
                            <div className="flex items-center gap-2">
                              <span className={cn(
                                "text-[10px] font-bold px-1.5 py-0.5 rounded uppercase",
                                item.speaker === 'me' ? "bg-brand-100 text-brand-700" : 
                                (item.speaker === 'other' ? "bg-slate-100 text-slate-600" : "bg-amber-100 text-amber-700")
                              )}>
                                {speakerName}
                              </span>
                              <span className="text-[10px] text-slate-400">{format(item.timestamp, 'HH:mm:ss')}</span>
                            </div>
                            <p className="text-slate-700 leading-relaxed">{item.text}</p>
                          </motion.div>
                        );
                      })
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
                    <div ref={transcriptEndRef} />
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

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 overflow-y-auto no-scrollbar pr-1">
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
                  <Languages className="w-4 h-4 text-brand-500" />
                  识别语言
                </h3>
                <p className="text-xs text-slate-500">选择最适合当前对话的语言，以提高转写准确度（支持口音识别）。</p>
                <select 
                  value={recognitionLang}
                  onChange={(e) => setRecognitionLang(e.target.value)}
                  className="mac-input w-full py-1.5 text-xs"
                >
                  <option value="zh-CN">普通话 (中国大陆)</option>
                  <option value="en-US">英语 (美国)</option>
                  <option value="zh-HK">粤语 (香港)</option>
                  <option value="zh-TW">国语 (台湾)</option>
                  <option value="en-GB">英语 (英国)</option>
                </select>
              </section>

              <section className="mac-card p-5 space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="font-bold text-sm flex items-center gap-2">
                    <Users className="w-4 h-4 text-brand-500" />
                    关注人 (最多 4 人)
                  </h3>
                  {!isAddingPerson && (profile?.followedPersons?.length || 0) < 4 && (
                    <button 
                      onClick={() => setIsAddingPerson(true)}
                      className="text-[10px] font-bold text-brand-600 hover:text-brand-700"
                    >
                      + 添加关注人
                    </button>
                  )}
                </div>
                
                {isAddingPerson && (
                  <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 space-y-3">
                    <input 
                      type="text" 
                      placeholder="姓名/称呼" 
                      value={newPersonName}
                      onChange={(e) => setNewPersonName(e.target.value)}
                      className="mac-input w-full py-1.5 text-xs"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button 
                        onClick={addFollowedPerson}
                        className="flex-1 py-1.5 bg-brand-500 text-white rounded-lg text-[10px] font-bold"
                      >
                        确认添加
                      </button>
                      <button 
                        onClick={() => setIsAddingPerson(false)}
                        className="flex-1 py-1.5 bg-white border border-slate-200 text-slate-500 rounded-lg text-[10px] font-bold"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  {profile?.followedPersons && profile.followedPersons.length > 0 ? (
                    profile.followedPersons.map(person => (
                      <div key={person.id} className="flex items-center justify-between p-3 bg-slate-50/50 rounded-xl border border-slate-100">
                        <div>
                          <p className="text-xs font-bold text-slate-700">{person.name}</p>
                          <p className="text-[10px] text-slate-400">
                            {person.voiceFrequency ? `已录入声纹 (${person.sampleCount} 个样本)` : '待录入声纹'}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button 
                            onClick={() => startVoiceCollection(person.id)}
                            disabled={isCollectingVoice}
                            className="p-1.5 text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
                            title="录入声纹"
                          >
                            <Mic className="w-3.5 h-3.5" />
                          </button>
                          <button 
                            onClick={() => removeFollowedPerson(person.id)}
                            className="p-1.5 text-red-400 hover:bg-red-50 rounded-lg transition-colors"
                            title="移除"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-[10px] text-slate-400 text-center py-2">暂无关注人，点击上方按钮添加</p>
                  )}
                </div>
              </section>

              <section className="mac-card p-5 space-y-3">
                <h3 className="font-bold text-sm flex items-center gap-2">
                  <User className="w-4 h-4 text-brand-500" />
                  我的声纹
                </h3>
                <p className="text-xs text-slate-500">采集您的声音样本，以便系统能够准确区分“我”与“他人”。</p>
                <button 
                  onClick={() => startVoiceCollection()}
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
                    {selectedRecord.transcript.map((item, idx) => {
                      const speakerName = item.speaker === 'me' 
                        ? '我' 
                        : (profile?.followedPersons?.find(p => p.id === item.speaker)?.name || '他人');
                      
                      return (
                        <div key={idx} className="space-y-1 group/item">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className={cn(
                                "text-[10px] font-bold px-1.5 py-0.5 rounded uppercase",
                                item.speaker === 'me' ? "bg-brand-100 text-brand-700" : 
                                (item.speaker === 'other' ? "bg-slate-100 text-slate-600" : "bg-amber-100 text-amber-700")
                              )}>
                                {speakerName}
                              </span>
                              <span className="text-[10px] text-slate-400">{format(item.timestamp, 'HH:mm:ss')}</span>
                            </div>
                            
                            {/* Manual Tagging in Playback */}
                            <div className="opacity-0 group-hover/item:opacity-100 transition-opacity flex gap-1">
                              <button 
                                onClick={() => tagSpeakerInTranscript(selectedRecord.id, idx, 'me')}
                                className="text-[9px] px-1.5 py-0.5 bg-brand-50 text-brand-600 rounded hover:bg-brand-100"
                              >
                                标记为我
                              </button>
                              {profile?.followedPersons?.map(person => (
                                <button 
                                  key={person.id}
                                  onClick={() => tagSpeakerInTranscript(selectedRecord.id, idx, person.id)}
                                  className="text-[9px] px-1.5 py-0.5 bg-amber-50 text-amber-600 rounded hover:bg-amber-100"
                                >
                                  标记为{person.name}
                                </button>
                              ))}
                              {item.speaker !== 'other' && (
                                <button 
                                  onClick={() => tagSpeakerInTranscript(selectedRecord.id, idx, 'other')}
                                  className="text-[9px] px-1.5 py-0.5 bg-slate-50 text-slate-600 rounded hover:bg-slate-100"
                                >
                                  标记为他人
                                </button>
                              )}
                            </div>
                          </div>
                          <p className="text-slate-700 leading-relaxed">{item.text}</p>
                        </div>
                      );
                    })}
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
