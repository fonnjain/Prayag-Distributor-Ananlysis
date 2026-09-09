import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide40() {
  return (
    <Frame number={40} section="Product Tour">
      <SectionTitle eyebrow="SALES" title="Sales: Primary Performance" subtitle="Company to distributor dispatch." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Invoiced sales tracking</Bullet>
          <Bullet>Credit limit utilization</Bullet>
          <Bullet>Distributor-level primary targets</Bullet>
          <Bullet>Returns and cancellation monitoring</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col justify-center">
          <div className="flex items-end gap-[1vw] h-[20vh] pb-[1vh] border-b border-[#a9b7c2]/20">
            <div className="flex-1 h-[40%] bg-[#1389e8] rounded-t opacity-80" />
            <div className="flex-1 h-[60%] bg-[#1389e8] rounded-t opacity-80" />
            <div className="flex-1 h-[80%] bg-[#1389e8] rounded-t opacity-80" />
            <div className="flex-1 h-[50%] bg-[#1389e8] rounded-t opacity-80" />
            <div className="flex-1 h-[90%] bg-[#1389e8] rounded-t opacity-80" />
            <div className="flex-1 h-[70%] bg-[#1389e8] rounded-t opacity-80" />
          </div>
          <div className="flex justify-between mt-[1vh] text-[1.5vw] text-[#a9b7c2]">
            <span>Apr</span>
            <span>May</span>
            <span>Jun</span>
            <span>Jul</span>
            <span>Aug</span>
            <span>Sep</span>
          </div>
        </div>
      </div>
    </Frame>
  );
}
