import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide19() {
  return (
    <Frame number={19} section="Product Tour">
      <SectionTitle eyebrow="ARCHITECTURE" title="Secure Access & Navigation" subtitle="Role-based routing and universal search." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Persistent AppShell across all views</Bullet>
          <Bullet>Role-aware navigation grouping</Bullet>
          <Bullet>Polled alert counts for real-time awareness</Bullet>
          <Bullet>Dark/light mode aesthetic support</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col relative overflow-hidden">
          <div className="absolute inset-0 bg-[linear-gradient(45deg,rgba(19,137,232,0.1),transparent)]" />
          <div className="flex gap-[2vw] opacity-80 h-[30vh] relative z-10">
            <div className="w-[30%] border-r border-[#a9b7c2]/20 flex flex-col gap-[2vh] pr-[1vw]">
               <div className="h-[2vh] w-[60%] bg-[#1389e8]/50 rounded" />
               <div className="h-[2vh] w-[80%] bg-[#a9b7c2]/30 rounded" />
               <div className="h-[2vh] w-[70%] bg-[#a9b7c2]/30 rounded" />
            </div>
            <div className="flex-1 flex flex-col gap-[2vh]">
               <div className="h-[4vh] w-[30%] bg-[#a9b7c2]/20 rounded" />
               <div className="flex-1 bg-[#08121f]/60 border border-[#a9b7c2]/20 rounded" />
            </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
