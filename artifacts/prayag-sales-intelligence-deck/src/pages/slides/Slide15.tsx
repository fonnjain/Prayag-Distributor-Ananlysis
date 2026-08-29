import { Frame, Pill, SectionTitle } from '../../DeckShared';

export default function Slide15() {
  return (
    <Frame number={15} section="14 / PEOPLE & ACCOUNTABILITY">
      <SectionTitle eyebrow="14 / PEOPLE & ACCOUNTABILITY" title="Keep people, access, and accountability together" />
      <div className="absolute left-[7vw] top-[42vh] w-[35vw] space-y-[1.8vh]">
        <div className="panel-soft flex items-center gap-[1vw] p-[1.15vw]"><Pill>ACCESS</Pill><span className="text-[1.5vw]">Authenticated roles separate everyday work from administration</span></div>
        <div className="panel-soft flex items-center gap-[1vw] p-[1.15vw]"><Pill>PEOPLE</Pill><span className="text-[1.5vw]">People and customer ownership can be managed centrally</span></div>
        <div className="panel-soft flex items-center gap-[1vw] p-[1.15vw]"><Pill tone="amber">AUDIT</Pill><span className="text-[1.5vw]">Admins can review User Activity and Audit reports</span></div>
        <div className="panel-soft flex items-center gap-[1vw] p-[1.15vw]"><Pill tone="green">PRIVACY</Pill><span className="text-[1.5vw]">Activity analytics records safe page and action events without capturing content or keystrokes</span></div>
      </div>
      <div className="absolute right-[7vw] top-[40vh] w-[40vw]">
        <div className="relative h-[28vh]">
          <div className="absolute left-[12vw] top-0 flex h-[8vw] w-[8vw] items-center justify-center rounded-full border-[.12vw] border-[#1389e8]/65 bg-[#1389e8]/15 text-center font-display text-[1.5vw] font-semibold">ADMIN</div>
          <div className="absolute left-[2vw] top-[10vh] flex h-[7vw] w-[7vw] items-center justify-center rounded-full border-[.12vw] border-[#f3b44b]/60 bg-[#f3b44b]/12 text-center font-display text-[1.5vw] font-semibold">PEOPLE</div>
          <div className="absolute right-[2vw] top-[10vh] flex h-[7vw] w-[7vw] items-center justify-center rounded-full border-[.12vw] border-[#4ccfa3]/60 bg-[#4ccfa3]/12 text-center font-display text-[1.5vw] font-semibold">ACTIVITY</div>
          <div className="absolute left-[18vw] top-[8vh] h-[5vh] w-[.12vw] bg-[#2b6286]" /><div className="absolute left-[9vw] top-[14vh] h-[.12vw] w-[7vw] bg-[#2b6286]" /><div className="absolute right-[9vw] top-[14vh] h-[.12vw] w-[7vw] bg-[#2b6286]" />
        </div>
      </div>
    </Frame>
  );
}