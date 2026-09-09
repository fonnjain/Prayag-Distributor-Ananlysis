import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide28() {
  return (
    <Frame number={28} section="Product Tour">
      <SectionTitle eyebrow="INTELLIGENCE" title="Intelligence: AI Reports" subtitle="Automated narrative generation." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Written executive summaries</Bullet>
          <Bullet>Anomaly explanation</Bullet>
          <Bullet>Highlights key operational shifts</Bullet>
          <Bullet>Exportable formats for immediate sharing</Bullet>
        </div>
        <div className="flex-1 panel p-[2.5vw] flex flex-col gap-[1.5vh] relative overflow-hidden">
          <div className="absolute top-0 right-[2vw] w-[4vw] h-[6vh] bg-[#1389e8]/20 rounded-b" />
          <div className="text-[1.5vw] font-display text-[#f5f2ea] mb-[1vh]">Weekly Performance Narrative</div>
          <div className="h-[1.2vh] w-full bg-[#a9b7c2]/20 rounded" />
          <div className="h-[1.2vh] w-[95%] bg-[#a9b7c2]/20 rounded" />
          <div className="h-[1.2vh] w-[90%] bg-[#a9b7c2]/20 rounded" />
          <div className="h-[1.2vh] w-[60%] bg-[#a9b7c2]/20 rounded" />
          <div className="h-[1.2vh] w-full bg-[#a9b7c2]/20 rounded mt-[2vh]" />
          <div className="h-[1.2vh] w-[85%] bg-[#a9b7c2]/20 rounded" />
        </div>
      </div>
    </Frame>
  );
}
