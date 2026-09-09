import { Frame, SectionTitle, Bullet } from '../../DeckShared';

export default function Slide27() {
  return (
    <Frame number={27} section="Product Tour">
      <SectionTitle eyebrow="INTELLIGENCE" title="Intelligence: AI Analyst" subtitle="Natural language querying of sales data." />
      <div className="absolute left-[7vw] top-[38vh] w-[86vw] flex gap-[4vw]">
        <div className="w-[30vw] flex flex-col gap-[2.5vh]">
          <Bullet>Ask complex data questions in English</Bullet>
          <Bullet>Context-aware data retrieval</Bullet>
          <Bullet>Instant chart generation</Bullet>
          <Bullet>Transparent sourcing of answers</Bullet>
        </div>
        <div className="flex-1 panel p-[2vw] relative flex flex-col gap-[2vh]">
          <div className="self-end bg-[#1389e8]/20 border border-[#1389e8]/40 p-[1vw] rounded-[1vw] rounded-tr-none w-[70%]">
             <div className="text-[2vw] text-[#e4ebef]">Show me the top X districts by secondary sales growth in QX.</div>
          </div>
          <div className="self-start bg-[#08121f]/60 border border-[#a9b7c2]/20 p-[1.5vw] rounded-[1vw] rounded-tl-none w-[85%]">
             <div className="text-[2vw] text-[#a9b7c2] mb-[1vh]">Here are the top X districts based on QX secondary sales:</div>
             <div className="flex gap-[1vw] mt-[1.5vh]">
               <div className="h-[6vh] w-[2vw] bg-[#4ccfa3]/40 rounded" />
               <div className="h-[6vh] w-[2vw] bg-[#4ccfa3]/30 rounded" />
               <div className="h-[6vh] w-[2vw] bg-[#4ccfa3]/20 rounded" />
             </div>
          </div>
        </div>
      </div>
    </Frame>
  );
}
